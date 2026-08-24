// tests/aggregate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pairKey, pinnedKeysOf, deriveDaily, deriveLatest } from "../scripts/lib/aggregate.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));
const MEL = ["BNE", "MEL", "SCL", "CWB"];
const SYD = ["BNE", "SYD", "SCL", "CWB"];

const offer = (price, outRoute = SYD) => ({
  priceAud2pax: price, validating: "QF", carriers: ["QF", "LA"], outRoute,
  backRoute: [], outStops: outRoute.length - 2, outDurationMin: 1800,
});
const rec = (over) => ({
  ts: "2026-08-17T02:00:00Z", origin: "BNE", dest: "CWB",
  depDate: "2027-02-06", retDate: "2027-03-14", tripDays: 36,
  status: "ok", cheapest: offer(4000), cheapestLatam: offer(4100),
  routes: { viaMel: null, viaSyd: null }, ...over,
});
const now = new Date("2026-08-17T06:00:00Z");
const budget = { month: "2026-08", callsUsed: 10, cap: 235 };
const latestOf = (records, over) => deriveLatest(records, { config, budget, sweepCursor: 5, now, ...over });

test("pinnedKeysOf builds one pair key per tracked destination", () => {
  assert.deepEqual(pinnedKeysOf(config), ["CWB|2027-02-06|2027-03-14"]);
});

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

/* ---------------------------------------------------------------- *
 * routeDaily — the per-watched-route daily series the trend chart needs
 * ---------------------------------------------------------------- */

test("deriveDaily builds a daily minimum per watched route", () => {
  const records = [
    rec({ ts: "2026-08-16T22:00:00Z", routes: { viaMel: offer(5800, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-17T02:00:00Z", routes: { viaMel: offer(5700, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-17T10:00:00Z", routes: { viaMel: offer(5900, MEL), viaSyd: offer(6100) } }),
  ];
  const d = deriveDaily(records, now);
  assert.deepEqual(d.routeDaily.viaMel, { "2026-08-16": 5800, "2026-08-17": 5700 });
  assert.deepEqual(d.routeDaily.viaSyd, { "2026-08-17": 6100 });
});

test("routeDaily's daily minimum, not the latest reading, is what a movement delta must use", () => {
  // Regression for the primary-route hero: 23 Aug's two viaMel readings were 5642 then
  // 5687 (in that order). assets/app.js's routeMove() must diff routeDaily's minima
  // (5642 vs the prior day) — never latest.json's `current.priceAud2pax` (5687, the
  // *latest* reading, not the day's cheapest) — or the hero and the route panel below
  // it disagree on whether the price rose or fell.
  const records = [
    rec({ ts: "2026-08-17T02:00:00Z", routes: { viaMel: offer(5644, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-23T22:00:00Z", routes: { viaMel: offer(5642, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-23T22:16:00Z", routes: { viaMel: offer(5687, MEL), viaSyd: null } }),
  ];
  const d = deriveDaily(records, now);
  assert.deepEqual(d.routeDaily.viaMel, { "2026-08-17": 5644, "2026-08-23": 5642 });
});

test("routeDaily narrows to the pinned pair when given its keys", () => {
  const records = [
    rec({ ts: "2026-08-17T02:00:00Z", routes: { viaMel: offer(5700, MEL), viaSyd: null } }),
    // A sweep row on other dates: comparable to nothing else on the chart.
    rec({ ts: "2026-08-17T13:00:00Z", depDate: "2027-02-11", retDate: "2027-03-13", tripDays: 30, routes: { viaMel: offer(4200, MEL), viaSyd: null } }),
  ];
  const all = deriveDaily(records, now);
  assert.equal(all.routeDaily.viaMel["2026-08-17"], 4200, "unfiltered, the cheapest row of the day wins");
  const pinnedOnly = deriveDaily(records, now, { pinnedKeys: pinnedKeysOf(config) });
  assert.equal(pinnedOnly.routeDaily.viaMel["2026-08-17"], 5700, "filtered, only the pinned pair contributes");
});

test("deriveDaily drops destinations that are no longer tracked", () => {
  // history.jsonl keeps every GRU row forever; daily.json is a derived view of what
  // is tracked now, and the dashboard builds its controls from its keys.
  const records = [rec(), rec({ dest: "GRU", cheapest: offer(2000, ["BNE", "MEL", "SCL", "GRU"]) })];
  const all = deriveDaily(records, now);
  assert.deepEqual(Object.keys(all.bestPerDay).sort(), ["CWB", "GRU"], "unfiltered, every dest in the file shows");
  const tracked = deriveDaily(records, now, { dests: config.destinations });
  assert.deepEqual(Object.keys(tracked.bestPerDay), ["CWB"]);
  assert.ok(Object.keys(tracked.pairs).every((k) => k.startsWith("CWB|")));
});

test("routeDaily ignores error rows and empty slots", () => {
  const records = [
    rec({ ts: "2026-08-17T02:00:00Z", status: "error", cheapest: null, cheapestLatam: null, routes: { viaMel: offer(1, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-17T03:00:00Z", status: "empty", cheapest: null, cheapestLatam: null }),
  ];
  const d = deriveDaily(records, now);
  assert.deepEqual(d.routeDaily, {});
});

/* ---------------------------------------------------------------- *
 * Legacy rows
 * ---------------------------------------------------------------- */

const OFF_PATH = ["BNE", "DFW", "GIG", "CWB"]; // the routing most legacy rows recorded

const legacyRow = (over) => {
  const r = { ...rec({ idealRoute: null, ...over }) };
  delete r.routes;
  return r;
};

test("a pre-redesign row's idealRoute is read as the viaSyd watch slot", () => {
  // Every row written before 2026-08-24 carries `idealRoute` and no `routes`.
  // That path WAS BNE→SYD→SCL→CWB, so it belongs to viaSyd and nowhere else.
  const legacy = legacyRow({ ts: "2026-08-17T05:00:00Z", cheapest: offer(3900, OFF_PATH), idealRoute: offer(4050) });
  const l = latestOf([legacy]);
  assert.equal(l.routes.viaSyd.current.priceAud2pax, 4050);
  assert.equal(l.routes.viaSyd.lastSeen.ts, "2026-08-17T05:00:00Z");
  assert.equal(l.routes.viaMel.current, null, "nothing in the row speaks for the via-MEL path");
  // Like the cheapest-recovery path below, the idealRoute shim now needs to be told
  // viaSyd is actually watched — it no longer fires on watchedRoutes' default of [].
  assert.equal(deriveDaily([legacy], now).routeDaily.viaSyd, undefined);
  const d = deriveDaily([legacy], now, { watchedRoutes: config.watchedRoutes });
  assert.equal(d.routeDaily.viaSyd["2026-08-17"], 4050);
});

test("a pre-redesign row whose cheapest lies on a watched path fills that slot exactly", () => {
  // A global minimum that lies on path P is also P's minimum, so this is a recovery
  // of recorded fact, not an estimate — the row would have written the same offer.
  const legacy = legacyRow({ ts: "2026-08-17T05:00:00Z", cheapest: offer(5687, MEL) });
  const l = latestOf([legacy]);
  assert.equal(l.routes.viaMel.current.priceAud2pax, 5687);
  assert.deepEqual(l.routes.viaMel.current.outRoute, MEL);
  assert.equal(l.routes.viaSyd.current, null);
  // Recovering a legacy row needs the paths, so routeDaily only sees it when told them.
  assert.equal(deriveDaily([legacy], now).routeDaily.viaMel, undefined);
  const d = deriveDaily([legacy], now, { watchedRoutes: config.watchedRoutes });
  assert.equal(d.routeDaily.viaMel["2026-08-17"], 5687);
});

test("the recovered cheapest outranks a legacy idealRoute on the same path", () => {
  // idealRoute was gated to all-LATAM options, so it can only ever be the dearer
  // of the two. The new rule is path-only, and the cheapest on the path wins.
  const legacy = legacyRow({ cheapest: offer(3480, SYD), idealRoute: offer(3765, SYD) });
  assert.equal(latestOf([legacy]).routes.viaSyd.current.priceAud2pax, 3480);
});

test("a pre-redesign row with nothing on a watched path leaves every slot null", () => {
  const legacy = legacyRow({ cheapest: offer(4000, OFF_PATH) });
  const l = latestOf([legacy]);
  assert.equal(l.routes.viaSyd.current, null);
  assert.equal(l.routes.viaSyd.lastSeen, null);
  assert.equal(l.routes.viaMel.current, null);
  assert.equal(l.pinned.CWB.cheapest.priceAud2pax, 4000, "the row still counts as the pinned quote");
});

test("the legacy idealRoute shim does not resurrect a de-configured route", () => {
  // If viaSyd were ever dropped from config.watchedRoutes, the legacy `idealRoute`
  // fallback must not grow a `routes.viaSyd` slot behind its back — routeDaily
  // (and every other derived output) may only ever carry currently watched routes.
  const watchedRoutes = config.watchedRoutes.filter((r) => r.id !== "viaSyd");
  const legacy = legacyRow({ ts: "2026-08-17T05:00:00Z", cheapest: offer(3900, OFF_PATH), idealRoute: offer(4050, SYD) });
  const d = deriveDaily([legacy], now, { watchedRoutes });
  assert.equal(d.routeDaily.viaSyd, undefined, "no viaSyd series when it isn't watched");
  assert.deepEqual(Object.keys(d.routeDaily), [], "the off-path row matches no configured route either");
  const l = deriveLatest([legacy], { config: { ...config, watchedRoutes }, budget, sweepCursor: 5, now });
  assert.deepEqual(Object.keys(l.routes), ["viaMel"], "deriveLatest's own route slots are unaffected either way");
});

/* ---------------------------------------------------------------- *
 * deriveLatest
 * ---------------------------------------------------------------- */

test("deriveLatest: pinned, deltas, bestInWindow, allTimeLow, alert", () => {
  const records = [
    rec({ ts: "2026-08-16T03:00:00Z", cheapest: offer(4200) }), // yesterday's pinned min
    rec({ ts: "2026-08-17T05:00:00Z", cheapest: offer(3900) }), // current pinned
    rec({ ts: "2026-08-17T04:00:00Z", depDate: "2027-02-10", retDate: "2027-03-20", tripDays: 38, cheapest: offer(3700) }),
    rec({ ts: "2026-08-15T04:00:00Z", depDate: "2027-02-10", retDate: "2027-03-20", tripDays: 38, cheapest: offer(3300) }), // stale + all-time low
  ];
  const l = latestOf(records);
  assert.equal(l.pinned.CWB.cheapest.priceAud2pax, 3900);
  assert.equal(l.deltas.CWB.vsYesterdayAud, -300); // 3900 - 4200
  assert.equal(l.deltas.CWB.vs7dAud, null);
  assert.equal(l.bestInWindow.CWB.priceAud2pax, 3700); // most-recent-per-pair, not the stale 3300
  assert.equal(l.allTimeLow.CWB.priceAud2pax, 3300);
  assert.equal(l.alert.active, true); // 3900 <= 4500 target
  assert.equal(l.alert.priceAud2pax, 3900);
  assert.equal(l.sweepCursor, 5);
  assert.equal(l.updatedAt, now.toISOString());
  assert.equal(l.idealRoute, undefined, "the single ideal route is replaced by the watched-route map");
});

test("deriveLatest never reports a destination outside config.destinations", () => {
  const records = [rec(), rec({ dest: "GRU", cheapest: offer(2000, ["BNE", "MEL", "SCL", "GRU"]) })];
  const l = latestOf(records);
  assert.deepEqual(Object.keys(l.pinned), ["CWB"]);
  assert.deepEqual(Object.keys(l.deltas), ["CWB"]);
  assert.deepEqual(Object.keys(l.bestInWindow), ["CWB"]);
  assert.deepEqual(Object.keys(l.allTimeLow), ["CWB"]);
  assert.equal(l.alert.priceAud2pax, 4000, "the alert reads CWB's 4000, never the dropped GRU row's 2000");
});

test("deriveLatest: each watched route carries its label, role, current price and ts", () => {
  const records = [
    rec({ ts: "2026-08-17T05:00:00Z", routes: { viaMel: offer(5687, MEL), viaSyd: null } }),
  ];
  const l = latestOf(records);
  assert.deepEqual(Object.keys(l.routes), ["viaMel", "viaSyd"]);
  assert.equal(l.routes.viaMel.label, "via Melbourne");
  assert.equal(l.routes.viaMel.role, "primary");
  assert.equal(l.routes.viaMel.current.priceAud2pax, 5687);
  assert.equal(l.routes.viaMel.currentTs, "2026-08-17T05:00:00Z");
  assert.deepEqual(l.routes.viaMel.lastSeen.offer, offer(5687, MEL));
  assert.equal(l.routes.viaSyd.label, "via Sydney");
  assert.equal(l.routes.viaSyd.role, "watch");
  assert.equal(l.routes.viaSyd.current, null);
  assert.equal(l.routes.viaSyd.currentTs, "2026-08-17T05:00:00Z", "the search ran; the route simply was not offered");
  assert.equal(l.routes.viaSyd.lastSeen, null);
});

test("deriveLatest: current comes from the pinned pair only, lastSeen from anywhere", () => {
  const records = [
    rec({ ts: "2026-08-14T05:00:00Z", routes: { viaMel: null, viaSyd: offer(6400) } }),
    rec({ ts: "2026-08-16T13:00:00Z", depDate: "2027-02-11", retDate: "2027-03-13", tripDays: 30, routes: { viaMel: null, viaSyd: offer(6200) } }),
    rec({ ts: "2026-08-17T05:00:00Z", routes: { viaMel: offer(5687, MEL), viaSyd: null } }),
  ];
  const l = latestOf(records);
  assert.equal(l.routes.viaSyd.current, null, "the newest pinned search did not return it");
  assert.deepEqual(l.routes.viaSyd.lastSeen, {
    offer: offer(6200), ts: "2026-08-16T13:00:00Z", depDate: "2027-02-11", retDate: "2027-03-13",
  }, "the sweep sighting is the most recent one anywhere");
});

test("deriveLatest: an error on the pinned pair does not blank a watched route", () => {
  const records = [
    rec({ ts: "2026-08-17T05:00:00Z", routes: { viaMel: offer(5687, MEL), viaSyd: null } }),
    rec({ ts: "2026-08-17T09:00:00Z", status: "error", cheapest: null, cheapestLatam: null, routes: {}, error: "SerpAPI search failed: 500" }),
  ];
  const l = latestOf(records);
  assert.equal(l.routes.viaMel.current.priceAud2pax, 5687);
  assert.equal(l.routes.viaMel.currentTs, "2026-08-17T05:00:00Z");
});

test("deriveLatest: with no records at all the watched-route slots still exist", () => {
  const l = latestOf([]);
  assert.deepEqual(l.pinned, {});
  assert.deepEqual(Object.keys(l.routes), ["viaMel", "viaSyd"]);
  assert.deepEqual(l.routes.viaMel, { label: "via Melbourne", role: "primary", current: null, currentTs: null, lastSeen: null });
});

test("deriveLatest: stable sort preserves input order on tied timestamps", () => {
  // Two ok records for pinned CWB pair with SAME ts but different prices
  // Stable sort must preserve input order, so later-in-input becomes .at(-1)
  const records = [
    rec({ ts: "2026-08-17T05:00:00Z", cheapest: offer(4100) }), // first: higher price
    rec({ ts: "2026-08-17T05:00:00Z", cheapest: offer(3900) }), // second: lower price, should be selected
  ];
  assert.equal(latestOf(records).pinned.CWB.cheapest.priceAud2pax, 3900);
});
