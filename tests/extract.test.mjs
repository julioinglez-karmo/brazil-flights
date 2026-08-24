// tests/extract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serpOfferSummary, extractSerpSearch, nullRoutes } from "../scripts/lib/extract.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/serpapi-cwb.json", import.meta.url)));
const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));

const opts = {
  latamCarriers: ["LA", "JJ", "XL", "LU", "LP", "PZ", "4C", "4M"],
  watchedRoutes: config.watchedRoutes,
  dest: "CWB",
};

const option = (price, legs) => ({
  price,
  total_duration: 1700,
  flights: legs.map(([from, to, airline, number]) => ({
    departure_airport: { id: from }, arrival_airport: { id: to }, airline, flight_number: number, duration: 300,
  })),
});

test("config declares the two watched routes the extractor matches on", () => {
  assert.deepEqual(config.watchedRoutes.map((r) => r.id), ["viaMel", "viaSyd"]);
  assert.deepEqual(config.watchedRoutes.find((r) => r.id === "viaMel").path, ["BNE", "MEL", "SCL", "CWB"]);
  assert.deepEqual(config.watchedRoutes.find((r) => r.id === "viaSyd").path, ["BNE", "SYD", "SCL", "CWB"]);
});

test("serpOfferSummary maps a google_flights option onto the OfferSummary shape", () => {
  const s = serpOfferSummary(body.best_flights[0]);
  assert.equal(s.priceAud2pax, 3480);
  assert.equal(s.validating, "QF");
  assert.deepEqual(s.carriers, ["QF", "LA"]);
  assert.deepEqual(s.outRoute, ["BNE", "SYD", "SCL", "CWB"]);
  assert.deepEqual(s.backRoute, [], "return leg needs a second departure_token call — out of budget");
  assert.equal(s.outStops, 2);
  assert.equal(s.outDurationMin, 1785);
});

test("extractSerpSearch picks cheapest, cheapest LATAM and each watched route independently", () => {
  const r = extractSerpSearch(body, opts);
  assert.equal(r.cheapest.priceAud2pax, 3480);
  assert.equal(r.cheapest.validating, "QF");
  assert.deepEqual(r.cheapest.outRoute, ["BNE", "SYD", "SCL", "CWB"]);
  assert.equal(r.cheapestLatam.priceAud2pax, 3610);
  assert.deepEqual(r.cheapestLatam.carriers, ["LA", "JJ"]);
  assert.deepEqual(Object.keys(r.routes), ["viaMel", "viaSyd"]);
  assert.equal(r.routes.viaMel, null, "the fixture carries no BNE→MEL→SCL→CWB itinerary");
});

test("a watched route matches on path alone — the carrier gate is gone", () => {
  // The old ideal-route rule required an all-LATAM itinerary and so returned the
  // 3765 option. Real via-MEL/SYD itineraries are QF-marketed with LATAM legs, so
  // carrier-gating would blank the card; the cheapest matching path wins instead.
  const r = extractSerpSearch(body, opts);
  assert.equal(r.routes.viaSyd.priceAud2pax, 3480);
  assert.equal(r.routes.viaSyd.validating, "QF");
  assert.deepEqual(r.routes.viaSyd.carriers, ["QF", "LA"], "the card shows the carriers instead of gating on them");
});

test("cheapestLatam keeps its all-LATAM rule while the watched route does not", () => {
  const mixed = option(2900, [
    ["BNE", "SYD", "Qantas", "QF 545"],
    ["SYD", "SCL", "LATAM", "LA 802"],
    ["SCL", "CWB", "LATAM", "LA 630"],
  ]);
  const r = extractSerpSearch({ best_flights: [mixed] }, opts);
  assert.equal(r.cheapest.priceAud2pax, 2900);
  assert.equal(r.cheapestLatam, null, "one non-LATAM segment still disqualifies the LATAM pool");
  assert.equal(r.routes.viaSyd.priceAud2pax, 2900, "but the path matches, so the watch card lights up");
});

test("LATAM rule accepts a segment by airline name when the flight-number prefix is unknown", () => {
  // Google exposes no validating carrier; a LATAM-operated leg can be marketed under an
  // unfamiliar prefix, so the airline-name fallback keeps it inside the LATAM pool.
  const r = extractSerpSearch({ best_flights: [option(3200, [
    ["BNE", "SYD", "LATAM Airlines", "2Z 11"],
    ["SYD", "SCL", "LATAM", "LA 802"],
    ["SCL", "CWB", "LATAM", "LA 630"],
  ])] }, opts);
  assert.equal(r.cheapestLatam.priceAud2pax, 3200);
  assert.equal(r.cheapestLatam.validating, "2Z", "validating is the honest marketing prefix, not a synthesised LA");
});

test("each watched route takes the cheapest option on its own exact path", () => {
  const r = extractSerpSearch({
    best_flights: [
      option(5900, [["BNE", "MEL", "Qantas", "QF 619"], ["MEL", "SCL", "LATAM", "LA 800"], ["SCL", "CWB", "LATAM", "LA 630"]]),
      option(5400, [["BNE", "MEL", "Qantas", "QF 613"], ["MEL", "SCL", "LATAM", "LA 800"], ["SCL", "CWB", "LATAM", "LA 632"]]),
      option(5100, [["BNE", "SYD", "Qantas", "QF 545"], ["SYD", "SCL", "LATAM", "LA 802"], ["SCL", "CWB", "LATAM", "LA 630"]]),
    ],
  }, opts);
  assert.equal(r.routes.viaMel.priceAud2pax, 5400);
  assert.equal(r.routes.viaSyd.priceAud2pax, 5100);
  assert.equal(r.cheapest.priceAud2pax, 5100);
});

test("a near-miss path does not count as the watched route", () => {
  const r = extractSerpSearch({
    best_flights: [
      // An extra hop and a different hub — both must miss viaMel.
      option(4800, [["BNE", "MEL", "Qantas", "QF 619"], ["MEL", "AKL", "Qantas", "QF 161"], ["AKL", "SCL", "LATAM", "LA 800"], ["SCL", "CWB", "LATAM", "LA 630"]]),
      option(4700, [["BNE", "AKL", "Qantas", "QF 121"], ["AKL", "SCL", "LATAM", "LA 800"], ["SCL", "CWB", "LATAM", "LA 630"]]),
    ],
  }, opts);
  assert.equal(r.routes.viaMel, null);
  assert.equal(r.routes.viaSyd, null);
  assert.equal(r.cheapest.priceAud2pax, 4700, "the itineraries still count toward cheapest overall");
});

test("extractSerpSearch pools best_flights and other_flights", () => {
  const onlyOther = extractSerpSearch({ other_flights: body.other_flights }, opts);
  assert.equal(onlyOther.cheapest.priceAud2pax, 3610);
  const onlyBest = extractSerpSearch({ best_flights: body.best_flights }, opts);
  assert.equal(onlyBest.cheapest.priceAud2pax, 3480);
  assert.equal(onlyBest.cheapestLatam.priceAud2pax, 3765, "option 3 lives in other_flights");
});

test("extractSerpSearch handles empty bodies and a destination off the watched paths", () => {
  const nulls = { cheapest: null, cheapestLatam: null, routes: { viaMel: null, viaSyd: null } };
  assert.deepEqual(extractSerpSearch({ best_flights: [], other_flights: [] }, opts), nulls);
  assert.deepEqual(extractSerpSearch({}, opts), nulls);
  const other = extractSerpSearch(body, { ...opts, dest: "GIG" });
  assert.deepEqual(other.routes, { viaMel: null, viaSyd: null }, "watched routes only apply to their own destination");
  assert.ok(other.cheapest);
});

test("nullRoutes builds the all-null slot map used by error rows", () => {
  assert.deepEqual(nullRoutes(config.watchedRoutes), { viaMel: null, viaSyd: null });
  assert.deepEqual(nullRoutes(undefined), {});
});
