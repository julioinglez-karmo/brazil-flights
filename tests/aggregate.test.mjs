// tests/aggregate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pairKey, deriveDaily, deriveLatest } from "../scripts/lib/aggregate.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const offer = (price) => ({ priceAud2pax: price, validating: "LA", carriers: ["LA"], outRoute: ["BNE", "SYD", "SCL", "CWB"], backRoute: ["CWB", "SCL", "SYD", "BNE"], outStops: 2, outDurationMin: 1800 });
const rec = (over) => ({ ts: "2026-08-17T02:00:00Z", origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14", tripDays: 36, status: "ok", cheapest: offer(4000), cheapestLatam: offer(4100), idealRoute: null, ...over });
const now = new Date("2026-08-17T06:00:00Z");

test("deriveDaily computes per-pair and per-dest daily minima, skipping non-ok rows", () => {
  const records = [
    rec({ cheapest: offer(4000) }),
    rec({ ts: "2026-08-17T03:00:00Z", cheapest: offer(3900) }),
    rec({ ts: "2026-08-16T03:00:00Z", cheapest: offer(4200) }),
    rec({ ts: "2026-08-17T04:00:00Z", status: "error", cheapest: null, cheapestLatam: null }),
    rec({ ts: "2026-08-17T04:00:00Z", depDate: "2027-02-10", retDate: "2027-03-20", tripDays: 38, cheapest: offer(3700) }),
  ];
  const d = deriveDaily(records, now);
  assert.equal(d.pairs[pairKey(records[0])]["2026-08-17"], 3900);
  assert.equal(d.pairs[pairKey(records[0])]["2026-08-16"], 4200);
  assert.equal(d.bestPerDay.CWB["2026-08-17"], 3700);
});

test("deriveLatest: pinned, deltas, bestInWindow, allTimeLow, alert", () => {
  const records = [
    rec({ ts: "2026-08-16T03:00:00Z", cheapest: offer(4200) }), // yesterday's pinned min
    rec({ ts: "2026-08-17T05:00:00Z", cheapest: offer(3900), idealRoute: offer(4050) }), // current pinned
    rec({ ts: "2026-08-17T04:00:00Z", depDate: "2027-02-10", retDate: "2027-03-20", tripDays: 38, cheapest: offer(3700) }),
    rec({ ts: "2026-08-15T04:00:00Z", depDate: "2027-02-10", retDate: "2027-03-20", tripDays: 38, cheapest: offer(3300) }), // stale + all-time low
  ];
  const budget = { month: "2026-08", callsUsed: 10, cap: 1950 };
  const l = deriveLatest(records, { config, budget, sweepCursor: 5, now });
  assert.equal(l.pinned.CWB.cheapest.priceAud2pax, 3900);
  assert.equal(l.deltas.CWB.vsYesterdayAud, -300); // 3900 - 4200
  assert.equal(l.deltas.CWB.vs7dAud, null);
  assert.equal(l.idealRoute.latest.priceAud2pax, 4050);
  assert.equal(l.idealRoute.lastSeen.ts, "2026-08-17T05:00:00Z");
  assert.equal(l.bestInWindow.CWB.priceAud2pax, 3700); // most-recent-per-pair, not the stale 3300
  assert.equal(l.allTimeLow.CWB.priceAud2pax, 3300);
  assert.equal(l.alert.active, true); // 3900 <= 4500 target
  assert.equal(l.alert.priceAud2pax, 3900);
  assert.equal(l.sweepCursor, 5);
  assert.equal(l.updatedAt, now.toISOString());
});
