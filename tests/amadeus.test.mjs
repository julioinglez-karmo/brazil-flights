import test from "node:test";
import assert from "node:assert/strict";
import { AmadeusClient } from "../scripts/lib/amadeus.mjs";

function jsonResponse(status, body) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("authenticates once, searches with correct params", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("/security/oauth2/token")) {
      return jsonResponse(200, { access_token: "tok123", expires_in: 1799 });
    }
    return jsonResponse(200, { data: [] });
  };
  const c = new AmadeusClient({ clientId: "id", clientSecret: "sec", env: "test", fetchImpl });
  await c.searchFlightOffers({ origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14", adults: 2, currency: "AUD", maxOffers: 20 });
  await c.searchFlightOffers({ origin: "BNE", dest: "GRU", depDate: "2027-02-06", retDate: "2027-03-14", adults: 2, currency: "AUD", maxOffers: 20 });

  const tokenCalls = calls.filter((c) => c.url.includes("oauth2/token"));
  assert.equal(tokenCalls.length, 1); // token cached
  assert.match(tokenCalls[0].opts.body, /grant_type=client_credentials/);

  const search = calls.find((c) => c.url.includes("flight-offers"));
  const u = new URL(search.url);
  assert.equal(u.hostname, "test.api.amadeus.com");
  assert.equal(u.searchParams.get("originLocationCode"), "BNE");
  assert.equal(u.searchParams.get("destinationLocationCode"), "CWB");
  assert.equal(u.searchParams.get("departureDate"), "2027-02-06");
  assert.equal(u.searchParams.get("returnDate"), "2027-03-14");
  assert.equal(u.searchParams.get("adults"), "2");
  assert.equal(u.searchParams.get("currencyCode"), "AUD");
  assert.equal(u.searchParams.get("max"), "20");
  assert.equal(search.opts.headers.Authorization, "Bearer tok123");
});

test("retries 429 then succeeds; gives up after 3 attempts on 500", async () => {
  let searchAttempts = 0;
  const sleeps = [];
  const mk = (failures, failStatus) => async (url) => {
    if (String(url).includes("oauth2/token")) return jsonResponse(200, { access_token: "t" });
    searchAttempts++;
    return searchAttempts <= failures ? jsonResponse(failStatus, {}) : jsonResponse(200, { data: [] });
  };
  const sleepImpl = async (ms) => sleeps.push(ms);

  const ok = new AmadeusClient({ clientId: "i", clientSecret: "s", fetchImpl: mk(1, 429), sleepImpl });
  const body = await ok.searchFlightOffers({ origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14", adults: 2, currency: "AUD", maxOffers: 20 });
  assert.deepEqual(body, { data: [] });
  assert.deepEqual(sleeps, [2000]);

  searchAttempts = 0;
  const bad = new AmadeusClient({ clientId: "i", clientSecret: "s", fetchImpl: mk(99, 500), sleepImpl });
  await assert.rejects(
    () => bad.searchFlightOffers({ origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14", adults: 2, currency: "AUD", maxOffers: 20 }),
    /500/
  );
  assert.equal(searchAttempts, 3);
});
