import test from "node:test";
import assert from "node:assert/strict";
import { SerpApiClient } from "../scripts/lib/serpapi.mjs";

const KEY = "super-secret-key-abc123";
const search = { origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14", adults: 2, currency: "AUD" };

function jsonResponse(status, body) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("searches with correct google_flights params", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return jsonResponse(200, { search_metadata: { status: "Success" }, best_flights: [] });
  };
  const c = new SerpApiClient({ apiKey: KEY, fetchImpl });
  await c.searchFlightOffers(search);

  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.origin + u.pathname, "https://serpapi.com/search.json");
  assert.equal(u.searchParams.get("engine"), "google_flights");
  assert.equal(u.searchParams.get("departure_id"), "BNE");
  assert.equal(u.searchParams.get("arrival_id"), "CWB");
  assert.equal(u.searchParams.get("outbound_date"), "2027-02-06");
  assert.equal(u.searchParams.get("return_date"), "2027-03-14");
  assert.equal(u.searchParams.get("type"), "1"); // 1 = round trip
  assert.equal(u.searchParams.get("adults"), "2");
  assert.equal(u.searchParams.get("currency"), "AUD");
  assert.equal(u.searchParams.get("hl"), "en");
  assert.equal(u.searchParams.get("gl"), "au");
  assert.equal(u.searchParams.get("api_key"), KEY);
});

test("retries 429 then succeeds; gives up after 3 attempts on 500", async () => {
  let attempts = 0;
  const sleeps = [];
  const mk = (failures, failStatus) => async () => {
    attempts++;
    return attempts <= failures
      ? jsonResponse(failStatus, { message: "rate limited" })
      : jsonResponse(200, { search_metadata: { status: "Success" }, best_flights: [] });
  };
  const sleepImpl = async (ms) => sleeps.push(ms);

  const ok = new SerpApiClient({ apiKey: KEY, fetchImpl: mk(1, 429), sleepImpl });
  const body = await ok.searchFlightOffers(search);
  assert.deepEqual(body, { search_metadata: { status: "Success" }, best_flights: [] });
  assert.deepEqual(sleeps, [2000]);

  attempts = 0;
  sleeps.length = 0;
  const bad = new SerpApiClient({ apiKey: KEY, fetchImpl: mk(99, 500), sleepImpl });
  await assert.rejects(() => bad.searchFlightOffers(search), /500/);
  assert.equal(attempts, 3, "3 attempts total");
  assert.deepEqual(sleeps, [2000, 8000]);
});

test("non-retryable 4xx throws immediately", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return jsonResponse(401, { error: "Invalid API key" });
  };
  const c = new SerpApiClient({ apiKey: KEY, fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => c.searchFlightOffers(search), /401/);
  assert.equal(attempts, 1, "no retry on 4xx");
});

test("HTTP 200 body-level error throws immediately", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts++;
    return jsonResponse(200, { error: "Google Flights hasn't returned any results for this query." });
  };
  const c = new SerpApiClient({ apiKey: KEY, fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => c.searchFlightOffers(search), /hasn't returned any results/);
  assert.equal(attempts, 1, "body-level error is not retried");
});

test("api_key never leaks into thrown error messages", async () => {
  const cases = [
    async () => jsonResponse(500, { debug: `failed for api_key=${KEY}` }),
    async () => jsonResponse(400, { error: `bad request api_key=${KEY}` }),
    async () => jsonResponse(200, { error: `invalid api_key=${KEY}` }),
  ];
  for (const fetchImpl of cases) {
    const c = new SerpApiClient({ apiKey: KEY, fetchImpl, sleepImpl: async () => {} });
    const err = await c.searchFlightOffers(search).then(() => null, (e) => e);
    assert.ok(err, "expected a rejection");
    const msg = String(err.message ?? err);
    assert.ok(!msg.includes(KEY), `api_key leaked in: ${msg}`);
    assert.match(msg, /api_key=\*\*\*/, "key should be redacted, not merely absent");
  }
});
