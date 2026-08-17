// tests/extract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serpOfferSummary, extractSerpSearch } from "../scripts/lib/extract.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/serpapi-cwb.json", import.meta.url)));
const opts = {
  latamCarriers: ["LA", "JJ", "XL", "LU", "LP", "PZ", "4C", "4M"],
  idealRoutePath: ["BNE", "SYD", "SCL", "CWB"],
  dest: "CWB",
};

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

test("extractSerpSearch picks cheapest, cheapest LATAM, and ideal route independently", () => {
  const r = extractSerpSearch(body, opts);
  assert.equal(r.cheapest.priceAud2pax, 3480);
  assert.equal(r.cheapest.validating, "QF");
  assert.deepEqual(r.cheapest.outRoute, ["BNE", "SYD", "SCL", "CWB"]);
  assert.equal(r.cheapest.outStops, 2);
  assert.equal(r.cheapest.outDurationMin, 1785);
  assert.equal(r.cheapestLatam.priceAud2pax, 3610);
  assert.deepEqual(r.cheapestLatam.carriers, ["LA", "JJ"]);
  assert.equal(r.idealRoute.priceAud2pax, 3765); // option 2: only all-LATAM BNE>SYD>SCL>CWB
  assert.equal(
    r.idealRoute.validating,
    "LA",
    "ideal route must be all-LATAM (excludes option 1 at 3480 despite matching route and lower price)"
  );
});

test("extractSerpSearch pools best_flights and other_flights", () => {
  const onlyOther = extractSerpSearch({ other_flights: body.other_flights }, opts);
  assert.equal(onlyOther.cheapest.priceAud2pax, 3610);
  const onlyBest = extractSerpSearch({ best_flights: body.best_flights }, opts);
  assert.equal(onlyBest.cheapest.priceAud2pax, 3480);
  assert.equal(onlyBest.cheapestLatam.priceAud2pax, 3765, "option 3 lives in other_flights");
});

test("extractSerpSearch handles empty and non-matching dest", () => {
  const nulls = { cheapest: null, cheapestLatam: null, idealRoute: null };
  assert.deepEqual(extractSerpSearch({ best_flights: [], other_flights: [] }, opts), nulls);
  assert.deepEqual(extractSerpSearch({}, opts), nulls);
  const gru = extractSerpSearch(body, { ...opts, dest: "GRU" });
  assert.equal(gru.idealRoute, null); // ideal route only evaluated for CWB
  assert.ok(gru.cheapest);
});

test("LATAM rule accepts a segment by airline name when the flight-number prefix is unknown", () => {
  // Google exposes no validating carrier; a LATAM-operated leg can be marketed under an
  // unfamiliar prefix, so the airline-name fallback keeps it inside the LATAM pool.
  const option = {
    price: 3200,
    total_duration: 1700,
    flights: [
      { departure_airport: { id: "BNE" }, arrival_airport: { id: "SYD" }, airline: "LATAM Airlines", flight_number: "2Z 11", duration: 95 },
      { departure_airport: { id: "SYD" }, arrival_airport: { id: "SCL" }, airline: "LATAM", flight_number: "LA 802", duration: 775 },
      { departure_airport: { id: "SCL" }, arrival_airport: { id: "CWB" }, airline: "LATAM", flight_number: "LA 630", duration: 275 },
    ],
  };
  const r = extractSerpSearch({ best_flights: [option] }, opts);
  assert.equal(r.cheapestLatam.priceAud2pax, 3200);
  assert.equal(r.idealRoute.priceAud2pax, 3200);
  assert.equal(r.cheapestLatam.validating, "2Z", "validating is the honest marketing prefix, not a synthesised LA");
});

test("a single non-LATAM segment disqualifies the whole option from the LATAM pool", () => {
  const option = {
    price: 2900,
    total_duration: 1700,
    flights: [
      { departure_airport: { id: "BNE" }, arrival_airport: { id: "SYD" }, airline: "Qantas", flight_number: "QF 545", duration: 95 },
      { departure_airport: { id: "SYD" }, arrival_airport: { id: "SCL" }, airline: "LATAM", flight_number: "LA 802", duration: 775 },
      { departure_airport: { id: "SCL" }, arrival_airport: { id: "CWB" }, airline: "LATAM", flight_number: "LA 630", duration: 275 },
    ],
  };
  const r = extractSerpSearch({ best_flights: [option] }, opts);
  assert.equal(r.cheapest.priceAud2pax, 2900);
  assert.equal(r.cheapestLatam, null);
  assert.equal(r.idealRoute, null, "route matches but the itinerary is not all-LATAM");
});
