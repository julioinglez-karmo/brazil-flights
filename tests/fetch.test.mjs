import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFetch } from "../scripts/fetch.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/serpapi-cwb.json", import.meta.url)));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bf-"));
  cpSync(new URL("../data", import.meta.url).pathname, join(dir, "data"), { recursive: true });
  return dir;
}

const fakeClient = (log = []) => ({
  searchFlightOffers: async (params) => {
    log.push(params);
    if (params.dest === "GRU") throw new Error("SerpAPI search failed: 500");
    return fixture;
  },
});

test("pinned mode: 2 searches, error recorded as row, files updated", async () => {
  const dir = setup();
  const log = [];
  const { records, latest } = await runFetch({
    mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: fakeClient(log), now: new Date("2026-08-17T02:00:00Z"),
  });
  assert.equal(log.length, 2);
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.dest === "CWB").status, "ok");
  assert.equal(records.find((r) => r.dest === "GRU").status, "error");

  const history = readFileSync(join(dir, "data/history.jsonl"), "utf8").trim().split("\n");
  assert.equal(history.length, 2);
  assert.equal(latest.budget.callsUsed, 2);
  assert.equal(latest.pinned.CWB.cheapest.priceAud2pax, 3480);
  const onDisk = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  assert.deepEqual(onDisk, latest);
});

test("sweep mode advances cursor and respects batch size", async () => {
  const dir = setup();
  const log = [];
  const { latest } = await runFetch({
    mode: "sweep", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: fakeClient(log), now: new Date("2026-08-17T13:30:00Z"),
  });
  assert.equal(log.length, 4); // sweep.dailyCallBudget
  assert.equal(latest.sweepCursor, 4);
});

test("budget exhaustion stops before searching", async () => {
  const dir = setup();
  const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  seeded.budget = { month: "2026-08", callsUsed: 235, cap: 235 };
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));
  const log = [];
  const { records } = await runFetch({
    mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: fakeClient(log), now: new Date("2026-08-17T02:00:00Z"),
  });
  assert.equal(log.length, 0);
  assert.equal(records.length, 0);
});

test("empty search result records status empty with null extractions", async () => {
  const dir = setup();
  const emptyClient = (log = []) => ({
    searchFlightOffers: async (params) => {
      log.push(params);
      if (params.dest === "CWB") return { best_flights: [], other_flights: [] };
      return fixture;
    },
  });
  const log = [];
  const { records } = await runFetch({
    mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: emptyClient(log), now: new Date("2026-08-17T02:00:00Z"),
  });
  const cwbRecord = records.find((r) => r.dest === "CWB");
  assert.equal(cwbRecord.status, "empty");
  assert.equal(cwbRecord.cheapest, null);
  assert.equal(cwbRecord.cheapestLatam, null);
  assert.equal(cwbRecord.idealRoute, null);
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

    const { records } = await runFetch({
      mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
      client: fakeClient(), now: new Date("2026-08-17T02:00:00Z"),
    });

    const output = readFileSync(outputFile, "utf8");
    assert(output.includes("alert=true"), "should write alert=true");
    assert(output.includes("alert_price="), "should write alert_price=");
  } finally {
    process.env.GITHUB_OUTPUT = prevEnv;
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

    const { records } = await runFetch({
      mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
      client: fakeClient(), now: new Date("2026-08-17T02:00:00Z"),
    });

    const output = readFileSync(outputFile, "utf8");
    assert.equal(output, "", "should not write anything on repeated alert");
  } finally {
    process.env.GITHUB_OUTPUT = prevEnv;
  }
});

test("partial-trim sweep cursor: budget exhaustion mid-batch", async () => {
  const dir = setup();
  const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  seeded.budget = { month: "2026-08", callsUsed: 233, cap: 235 };
  seeded.sweepCursor = 0;
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));

  const log = [];
  const { records, latest } = await runFetch({
    mode: "sweep", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: fakeClient(log), now: new Date("2026-08-17T13:30:00Z"),
  });

  assert.equal(log.length, 2, "should make exactly 2 searches (remaining budget)");
  assert.equal(latest.sweepCursor, 2, "cursor should advance by 2");
  assert.equal(latest.budget.callsUsed, 235, "budget should reach cap");
});
