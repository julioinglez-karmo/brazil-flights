// tests/extract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDurationMin, extractSearch } from "../scripts/lib/extract.mjs";

const body = JSON.parse(readFileSync(new URL("./fixtures/amadeus-cwb.json", import.meta.url)));
const opts = {
  latamCarriers: ["LA", "JJ", "XL", "LU", "LP", "PZ", "4C", "4M"],
  idealRoutePath: ["BNE", "SYD", "SCL", "CWB"],
  dest: "CWB",
};

test("parseDurationMin", () => {
  assert.equal(parseDurationMin("PT32H50M"), 1970);
  assert.equal(parseDurationMin("PT2H"), 120);
  assert.equal(parseDurationMin("PT45M"), 45);
});

test("extractSearch picks cheapest, cheapest LATAM, and ideal route independently", () => {
  const r = extractSearch(body, opts);
  assert.equal(r.cheapest.priceAud2pax, 3480.1);
  assert.equal(r.cheapest.validating, "QF");
  assert.deepEqual(r.cheapest.outRoute, ["BNE", "SYD", "SCL", "CWB"]);
  assert.equal(r.cheapest.outStops, 2);
  assert.equal(r.cheapest.outDurationMin, 1785);
  assert.equal(r.cheapestLatam.priceAud2pax, 3610);
  assert.deepEqual(r.cheapestLatam.carriers, ["LA", "JJ"]);
  assert.equal(r.idealRoute.priceAud2pax, 3765.4); // offer 2: only all-LATAM BNE>SYD>SCL>CWB
});

test("extractSearch handles empty and non-matching dest", () => {
  assert.deepEqual(extractSearch({ data: [] }, opts), { cheapest: null, cheapestLatam: null, idealRoute: null });
  const gru = extractSearch(body, { ...opts, dest: "GRU" });
  assert.equal(gru.idealRoute, null); // ideal route only evaluated for CWB
  assert.ok(gru.cheapest);
});
