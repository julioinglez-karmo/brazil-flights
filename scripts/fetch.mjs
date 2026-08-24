import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sweepGrid, nextSweepBatch, daysBetween } from "./lib/dates.mjs";
import { normalizeBudget, remainingCalls, recordCalls } from "./lib/budget.mjs";
import { extractSerpSearch, nullRoutes } from "./lib/extract.mjs";
import { deriveDaily, deriveLatest, pinnedKeysOf } from "./lib/aggregate.mjs";
import { SerpApiClient } from "./lib/serpapi.mjs";

function readHistory(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function runFetch({ mode, dataDir, configPath, client, now }) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const latestPath = join(dataDir, "latest.json");
  const historyPath = join(dataDir, "history.jsonl");
  const prevLatest = JSON.parse(readFileSync(latestPath, "utf8"));

  let budget = normalizeBudget(prevLatest.budget, now, config.monthlyCallBudget);
  let sweepCursor = prevLatest.sweepCursor ?? 0;

  let grid = null;
  let units;
  if (mode === "pinned") {
    const { depDate, retDate } = config.pinned;
    units = config.destinations.map((dest) => ({ dest, depDate, retDate, tripDays: daysBetween(depDate, retDate) }));
  } else if (mode === "sweep") {
    grid = sweepGrid(config);
    const batch = nextSweepBatch(grid, sweepCursor, config.sweep.dailyCallBudget);
    units = batch.units;
    sweepCursor = batch.nextCursor;
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  const allowed = Math.min(units.length, remainingCalls(budget));
  if (allowed < units.length) {
    console.log(`::notice::budget limits run to ${allowed}/${units.length} searches (used ${budget.callsUsed}/${budget.cap})`);
    units = units.slice(0, allowed);
    if (mode === "sweep") sweepCursor = ((prevLatest.sweepCursor ?? 0) + allowed) % grid.length;
  }

  const records = [];
  for (const u of units) {
    const base = { ts: now.toISOString(), origin: config.origin, ...u };
    try {
      const body = await client.searchFlightOffers({
        origin: config.origin, dest: u.dest, depDate: u.depDate, retDate: u.retDate,
        adults: config.adults, currency: config.currency,
      });
      const ex = extractSerpSearch(body, { latamCarriers: config.latamCarriers, watchedRoutes: config.watchedRoutes, dest: u.dest });
      records.push({ ...base, status: ex.cheapest ? "ok" : "empty", ...ex });
    } catch (err) {
      records.push({ ...base, status: "error", cheapest: null, cheapestLatam: null, routes: nullRoutes(config.watchedRoutes), error: String(err.message ?? err) });
    }
  }
  budget = recordCalls(budget, units.length);

  for (const r of records) appendFileSync(historyPath, JSON.stringify(r) + "\n");
  const history = readHistory(historyPath);
  const daily = deriveDaily(history, now, {
    dests: config.destinations, pinnedKeys: pinnedKeysOf(config), watchedRoutes: config.watchedRoutes,
  });
  const latest = deriveLatest(history, { config, budget, sweepCursor, now });

  // Validate round-trip before publishing; a throw here leaves history intact and aborts the commit.
  JSON.parse(JSON.stringify(daily));
  JSON.parse(JSON.stringify(latest));
  writeFileSync(join(dataDir, "daily.json"), JSON.stringify(daily, null, 1) + "\n");
  writeFileSync(latestPath, JSON.stringify(latest, null, 1) + "\n");

  if (process.env.GITHUB_OUTPUT && !prevLatest.alert?.active && latest.alert.active) {
    appendFileSync(process.env.GITHUB_OUTPUT, `alert=true\nalert_price=${latest.alert.priceAud2pax}\n`);
  }
  console.log(`${mode}: ${records.length} searches, ${records.filter((r) => r.status === "ok").length} ok; budget ${budget.callsUsed}/${budget.cap}`);
  return { records, latest };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1));
if (isMain) {
  const { values } = parseArgs({ options: { mode: { type: "string" }, dataDir: { type: "string", default: "data" }, configPath: { type: "string", default: "config.json" } } });
  const client = new SerpApiClient({ apiKey: process.env.SERPAPI_API_KEY });
  runFetch({ mode: values.mode, dataDir: values.dataDir, configPath: values.configPath, client, now: new Date() })
    .catch((err) => { console.error(err); process.exit(1); });
}
