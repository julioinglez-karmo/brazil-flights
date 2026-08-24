import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFetch } from "../scripts/fetch.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/serpapi-cwb.json", import.meta.url)));
const configPath = new URL("../config.json", import.meta.url).pathname;

// Build a pristine data dir rather than copying live data/ — the workflows
// commit real rows there, and tests must not drift with production state.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bf-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data/history.jsonl"), "");
  writeFileSync(join(dir, "data/daily.json"), JSON.stringify({ generatedAt: null, pairs: {}, bestPerDay: {}, routeDaily: {} }));
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify({
    updatedAt: null,
    sweepCursor: 0,
    budget: { month: null, callsUsed: 0, cap: 235 },
    pinned: {}, deltas: {}, routes: {},
    bestInWindow: {}, allTimeLow: {},
    alert: { active: false, priceAud2pax: null, targetAud2pax: 4500 },
  }));
  return dir;
}

const fakeClient = (log = []) => ({
  searchFlightOffers: async (params) => { log.push(params); return fixture; },
});

const failingClient = (log = []) => ({
  searchFlightOffers: async (params) => { log.push(params); throw new Error("SerpAPI search failed: 500"); },
});

const run = (dir, over) => runFetch({
  dataDir: join(dir, "data"), configPath, now: new Date("2026-08-17T02:00:00Z"), ...over,
});

test("pinned mode: one search for the one tracked destination, files updated", async () => {
  const dir = setup();
  const log = [];
  const { records, latest } = await run(dir, { mode: "pinned", client: fakeClient(log) });
  assert.equal(log.length, 1);
  assert.equal(log[0].dest, "CWB", "GRU is no longer searched");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "ok");

  const history = readFileSync(join(dir, "data/history.jsonl"), "utf8").trim().split("\n");
  assert.equal(history.length, 1);
  assert.equal(latest.budget.callsUsed, 1);
  assert.equal(latest.pinned.CWB.cheapest.priceAud2pax, 3480);
  const onDisk = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  assert.deepEqual(onDisk, latest);
});

test("history rows carry a routes map, not a single idealRoute", async () => {
  const dir = setup();
  const { records, latest } = await run(dir, { mode: "pinned", client: fakeClient() });
  const row = records[0];
  assert.equal("idealRoute" in row, false);
  assert.deepEqual(Object.keys(row.routes), ["viaMel", "viaSyd"]);
  assert.equal(row.routes.viaMel, null);
  assert.equal(row.routes.viaSyd.priceAud2pax, 3480, "path match, no carrier gate");
  assert.equal(latest.routes.viaSyd.current.priceAud2pax, 3480);
  assert.equal(latest.routes.viaMel.current, null);
  assert.equal(latest.routes.viaMel.role, "primary");
});

test("daily.json carries the per-route pinned series", async () => {
  const dir = setup();
  await run(dir, { mode: "pinned", client: fakeClient() });
  const daily = JSON.parse(readFileSync(join(dir, "data/daily.json"), "utf8"));
  assert.deepEqual(daily.routeDaily, { viaSyd: { "2026-08-17": 3480 } });
});

test("a failed search is recorded as an error row with empty route slots", async () => {
  const dir = setup();
  const { records, latest } = await run(dir, { mode: "pinned", client: failingClient() });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "error");
  assert.deepEqual(records[0].routes, { viaMel: null, viaSyd: null });
  assert.equal(records[0].error, "SerpAPI search failed: 500");
  assert.deepEqual(latest.pinned, {}, "an error row never becomes the pinned quote");
});

test("sweep mode advances cursor and respects batch size", async () => {
  const dir = setup();
  const log = [];
  const { latest } = await run(dir, { mode: "sweep", client: fakeClient(log), now: new Date("2026-08-17T13:30:00Z") });
  assert.equal(log.length, 4); // sweep.dailyCallBudget
  assert.equal(latest.sweepCursor, 4);
});

test("budget exhaustion stops before searching", async () => {
  const dir = setup();
  const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  seeded.budget = { month: "2026-08", callsUsed: 235, cap: 235 };
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));
  const log = [];
  const { records } = await run(dir, { mode: "pinned", client: fakeClient(log) });
  assert.equal(log.length, 0);
  assert.equal(records.length, 0);
});

test("empty search result records status empty with null extractions", async () => {
  const dir = setup();
  const emptyClient = { searchFlightOffers: async () => ({ best_flights: [], other_flights: [] }) };
  const { records } = await run(dir, { mode: "pinned", client: emptyClient });
  assert.equal(records[0].status, "empty");
  assert.equal(records[0].cheapest, null);
  assert.equal(records[0].cheapestLatam, null);
  assert.deepEqual(records[0].routes, { viaMel: null, viaSyd: null });
});

test("GITHUB_OUTPUT alert crossing: false to true writes alert", async () => {
  const dir = setup();
  const outputFile = join(tmpdir(), `gh-output-${Date.now()}`);
  const prevEnv = process.env.GITHUB_OUTPUT;

  try {
    process.env.GITHUB_OUTPUT = outputFile;
    const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
    seeded.alert = { active: false, priceAud2pax: 5000 };
    writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));

    await run(dir, { mode: "pinned", client: fakeClient() });

    const output = readFileSync(outputFile, "utf8");
    assert(output.includes("alert=true"), "should write alert=true");
    assert(output.includes("alert_price="), "should write alert_price=");
  } finally {
    // Assigning undefined would set the variable to the STRING "undefined", and the
    // next run would append its alert to a file literally named `undefined`.
    if (prevEnv === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prevEnv;
  }
});

test("GITHUB_OUTPUT no repeat alert: true to true writes nothing", async () => {
  const dir = setup();
  const outputFile = join(tmpdir(), `gh-output-repeat-${Date.now()}`);
  writeFileSync(outputFile, "");
  const prevEnv = process.env.GITHUB_OUTPUT;

  try {
    process.env.GITHUB_OUTPUT = outputFile;
    const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
    seeded.alert = { active: true, priceAud2pax: 3000 };
    writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));

    await run(dir, { mode: "pinned", client: fakeClient() });

    const output = readFileSync(outputFile, "utf8");
    assert.equal(output, "", "should not write anything on repeated alert");
  } finally {
    // Assigning undefined would set the variable to the STRING "undefined", and the
    // next run would append its alert to a file literally named `undefined`.
    if (prevEnv === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prevEnv;
  }
});

test("partial-trim sweep cursor: budget exhaustion mid-batch", async () => {
  const dir = setup();
  const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  seeded.budget = { month: "2026-08", callsUsed: 233, cap: 235 };
  seeded.sweepCursor = 0;
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));

  const log = [];
  const { latest } = await run(dir, { mode: "sweep", client: fakeClient(log), now: new Date("2026-08-17T13:30:00Z") });

  assert.equal(log.length, 2, "should make exactly 2 searches (remaining budget)");
  assert.equal(latest.sweepCursor, 2, "cursor should advance by 2");
  assert.equal(latest.budget.callsUsed, 235, "budget should reach cap");
});

test("a legacy history file is aggregated without a crash", async () => {
  // The committed history.jsonl holds 64 pre-redesign rows keyed on `idealRoute`.
  const dir = setup();
  const legacy = {
    ts: "2026-08-16T22:00:00Z", origin: "BNE", dest: "CWB", depDate: "2027-02-06", retDate: "2027-03-14",
    tripDays: 36, status: "ok",
    cheapest: { priceAud2pax: 5727, validating: "QF", carriers: ["QF", "LA"], outRoute: ["BNE", "MEL", "SCL", "CWB"], backRoute: [], outStops: 2, outDurationMin: 2005 },
    cheapestLatam: null, idealRoute: null,
  };
  const gruLegacy = { ...legacy, dest: "GRU", cheapest: { ...legacy.cheapest, priceAud2pax: 3819 } };
  writeFileSync(join(dir, "data/history.jsonl"), JSON.stringify(legacy) + "\n" + JSON.stringify(gruLegacy) + "\n");

  const { latest } = await run(dir, { mode: "pinned", client: fakeClient() });
  assert.deepEqual(Object.keys(latest.pinned), ["CWB"], "the legacy GRU row stays in history but never surfaces");
  assert.equal(latest.allTimeLow.CWB.priceAud2pax, 3480);
  assert.equal(latest.routes.viaSyd.current.priceAud2pax, 3480);
});
