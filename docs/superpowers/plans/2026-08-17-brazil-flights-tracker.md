# Brazil Flights Price Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free GitHub Pages dashboard that auto-tracks BNE→CWB and BNE→GRU round-trip prices (2 adults, AUD, Feb 2027 out / Mar 2027 back, ≥30 days) via Amadeus, with hourly pinned checks, a daily sweep, permanent history, and LATAM/ideal-route highlighting.

**Architecture:** A Node.js fetch script run by two GitHub Actions cron jobs appends search results to `data/history.jsonl`, regenerates derived JSON (`daily.json`, `latest.json`), and commits — classic branch-based GitHub Pages serves the repo root, so every data commit republishes the static dashboard. No servers, no database, zero npm runtime dependencies.

**Tech Stack:** Node.js 22 (ESM `.mjs`, built-in `fetch` and `node:test`), GitHub Actions, GitHub Pages (branch `main`, folder `/`), vanilla HTML/CSS/JS dashboard, Chart.js from CDN for the trend chart.

**Spec:** `docs/superpowers/specs/2026-08-17-brazil-flights-tracker-design.md`

## Global Constraints

- Node.js ≥ 20 (CI uses 22); ESM only; **zero npm runtime dependencies** (built-in `fetch`, `node:test`).
- All prices are **AUD grand totals for 2 adults**, economy.
- Date window: depart Feb 2027, return Mar 2027, `tripDays ≥ 30`, return ≤ 2027-03-31.
- Monthly API budget hard cap: `config.monthlyCallBudget = 1950`; the script must never plan more calls than remain.
- Pinned cron (UTC): `0 20-23,0-12 * * *` (= hourly 06:00–22:00 Brisbane). Sweep cron (UTC): `30 13 * * *`.
- LATAM carrier codes: `["LA","JJ","XL","LU","LP","PZ","4C","4M"]`. Ideal route path: `["BNE","SYD","SCL","CWB"]` (outbound, dest CWB only).
- Amadeus base URLs: test `https://test.api.amadeus.com`, production `https://api.amadeus.com`, selected by env var `AMADEUS_ENV` (`test` default). Credentials via env `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` (GitHub Actions secrets — never committed).
- Dashboard is served from the **repo root** (`index.html`, `assets/`, `data/`) — deliberate deviation from the spec's `site/` folder so classic branch Pages republishes on bot commits.
- History is append-only; failed searches are recorded as rows (`status: "error"`), never dropped.
- Repo will be public; nothing sensitive may be written to tracked files.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `config.json`, `.gitignore`, `.nojekyll`, `README.md`, `data/history.jsonl` (empty), `data/latest.json`, `data/daily.json`

**Interfaces:**
- Produces: `config.json` shape consumed by every later task (exact keys below); seed `data/latest.json` shape consumed by Task 7 and Task 9.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "brazil-flights",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test tests/" }
}
```

- [ ] **Step 2: Create config.json**

```json
{
  "origin": "BNE",
  "destinations": ["CWB", "GRU"],
  "pinned": { "depDate": "2027-02-06", "retDate": "2027-03-14" },
  "sweep": {
    "depDates": { "month": "2027-02", "firstDay": 1, "lastDay": 27, "step": 2 },
    "tripLengths": [30, 33, 37, 41, 45],
    "minTripDays": 30,
    "latestReturn": "2027-03-31",
    "dailyCallBudget": 30
  },
  "monthlyCallBudget": 1950,
  "targetPriceAud2pax": 4500,
  "latamCarriers": ["LA", "JJ", "XL", "LU", "LP", "PZ", "4C", "4M"],
  "idealRoutePath": ["BNE", "SYD", "SCL", "CWB"],
  "adults": 2,
  "currency": "AUD",
  "maxOffers": 20
}
```

- [ ] **Step 3: Create seed data files**

`data/history.jsonl`: empty file.

`data/daily.json`:
```json
{ "generatedAt": null, "pairs": {}, "bestPerDay": {} }
```

`data/latest.json`:
```json
{
  "updatedAt": null,
  "sweepCursor": 0,
  "budget": { "month": null, "callsUsed": 0, "cap": 1950 },
  "pinned": {},
  "deltas": {},
  "idealRoute": { "latest": null, "latestTs": null, "lastSeen": null },
  "bestInWindow": {},
  "allTimeLow": {},
  "alert": { "active": false, "priceAud2pax": null, "targetAud2pax": 4500 }
}
```

- [ ] **Step 4: Create .gitignore, .nojekyll, README.md**

`.gitignore`:
```
node_modules/
.DS_Store
```

`.nojekyll`: empty file (stops GitHub Pages running Jekyll so `data/` and files with underscores serve as-is).

`README.md`: 5–10 lines — what the tracker does, link to the dashboard (placeholder URL until Task 10), where to edit `config.json`, note that prices are AUD totals for 2 adults.

- [ ] **Step 5: Verify test runner works and commit**

Run: `node --test tests/ ; echo "exit: $?"` — expected: exits 0 (no tests yet is fine; if node errors on the missing dir, `mkdir tests` first).

```bash
git add -A && git commit -m "chore: scaffold project (config, seed data, package.json)"
```

---

### Task 2: Date grid — `scripts/lib/dates.mjs`

**Files:**
- Create: `scripts/lib/dates.mjs`
- Test: `tests/dates.test.mjs`

**Interfaces:**
- Produces:
  - `addDays(iso: "YYYY-MM-DD", n: number) -> "YYYY-MM-DD"`
  - `daysBetween(a: iso, b: iso) -> number` (b − a in whole days)
  - `sweepGrid(config) -> Array<{dest, depDate, retDate, tripDays}>` — flattened over `config.destinations`, deterministic order (dest-major, then depDate, then tripDays), filtered to `tripDays ≥ minTripDays` and `retDate ≤ latestReturn`.
  - `nextSweepBatch(grid, cursor: number, batchSize: number) -> {units, nextCursor}` — wraps around; `cursor` may exceed `grid.length` (mod it).

- [ ] **Step 1: Write the failing tests**

```js
// tests/dates.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { addDays, daysBetween, sweepGrid, nextSweepBatch } from "../scripts/lib/dates.mjs";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));

test("addDays crosses month boundary", () => {
  assert.equal(addDays("2027-02-06", 36), "2027-03-14");
  assert.equal(addDays("2027-02-27", 30), "2027-03-29");
});

test("daysBetween", () => {
  assert.equal(daysBetween("2027-02-06", "2027-03-14"), 36);
});

test("sweepGrid respects constraints", () => {
  const grid = sweepGrid(config);
  // 54 valid date combos x 2 destinations
  assert.equal(grid.length, 108);
  for (const u of grid) {
    assert.ok(u.tripDays >= 30);
    assert.ok(u.retDate <= "2027-03-31");
    assert.ok(u.retDate >= "2027-03-01");
    assert.equal(daysBetween(u.depDate, u.retDate), u.tripDays);
  }
  // Feb 27 departure only fits trip length 30
  const feb27 = grid.filter((u) => u.depDate === "2027-02-27" && u.dest === "CWB");
  assert.deepEqual(feb27.map((u) => u.tripDays), [30]);
});

test("nextSweepBatch wraps around", () => {
  const grid = sweepGrid(config);
  const b1 = nextSweepBatch(grid, 100, 30);
  assert.equal(b1.units.length, 30);
  assert.equal(b1.nextCursor, 22); // (100 + 30) % 108
  assert.deepEqual(b1.units[8], grid[0]); // wrapped at index 108
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/dates.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/lib/dates.mjs
export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function sweepGrid(config) {
  const { depDates, tripLengths, minTripDays, latestReturn } = config.sweep;
  const units = [];
  for (const dest of config.destinations) {
    for (let day = depDates.firstDay; day <= depDates.lastDay; day += depDates.step) {
      const depDate = `${depDates.month}-${String(day).padStart(2, "0")}`;
      for (const tripDays of tripLengths) {
        const retDate = addDays(depDate, tripDays);
        if (tripDays >= minTripDays && retDate <= latestReturn) {
          units.push({ dest, depDate, retDate, tripDays });
        }
      }
    }
  }
  return units;
}

export function nextSweepBatch(grid, cursor, batchSize) {
  const start = cursor % grid.length;
  const units = [];
  for (let i = 0; i < Math.min(batchSize, grid.length); i++) {
    units.push(grid[(start + i) % grid.length]);
  }
  return { units, nextCursor: (start + units.length) % grid.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/dates.test.mjs` — expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/dates.mjs tests/dates.test.mjs
git commit -m "feat: sweep date grid generation with 30-day and March constraints"
```

---

### Task 3: Budget accounting — `scripts/lib/budget.mjs`

**Files:**
- Create: `scripts/lib/budget.mjs`
- Test: `tests/budget.test.mjs`

**Interfaces:**
- Produces:
  - `normalizeBudget(prev: {month,callsUsed,cap}|null, now: Date, cap: number) -> {month:"YYYY-MM", callsUsed, cap}` — resets `callsUsed` to 0 when the UTC month changed or prev is null; always applies the passed `cap`.
  - `remainingCalls(budget) -> number` (never negative)
  - `recordCalls(budget, n) -> budget` (new object, callsUsed += n)

- [ ] **Step 1: Write the failing tests**

```js
// tests/budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBudget, remainingCalls, recordCalls } from "../scripts/lib/budget.mjs";

const now = new Date("2026-09-03T10:00:00Z");

test("normalizeBudget resets on month change", () => {
  const prev = { month: "2026-08", callsUsed: 1900, cap: 1950 };
  assert.deepEqual(normalizeBudget(prev, now, 1950), { month: "2026-09", callsUsed: 0, cap: 1950 });
});

test("normalizeBudget keeps same-month usage and handles null", () => {
  const prev = { month: "2026-09", callsUsed: 120, cap: 1950 };
  assert.deepEqual(normalizeBudget(prev, now, 1950), { month: "2026-09", callsUsed: 120, cap: 1950 });
  assert.deepEqual(normalizeBudget(null, now, 1950), { month: "2026-09", callsUsed: 0, cap: 1950 });
});

test("remainingCalls and recordCalls", () => {
  const b = { month: "2026-09", callsUsed: 1940, cap: 1950 };
  assert.equal(remainingCalls(b), 10);
  assert.equal(remainingCalls(recordCalls(b, 15)), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/budget.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/lib/budget.mjs
export function normalizeBudget(prev, now, cap) {
  const month = now.toISOString().slice(0, 7);
  const callsUsed = prev && prev.month === month ? prev.callsUsed : 0;
  return { month, callsUsed, cap };
}

export function remainingCalls(budget) {
  return Math.max(0, budget.cap - budget.callsUsed);
}

export function recordCalls(budget, n) {
  return { ...budget, callsUsed: budget.callsUsed + n };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/budget.test.mjs` — expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/budget.mjs tests/budget.test.mjs
git commit -m "feat: monthly API call budget accounting with month rollover"
```

---

### Task 4: Offer extraction — `scripts/lib/extract.mjs` + fixture

**Files:**
- Create: `scripts/lib/extract.mjs`, `tests/fixtures/amadeus-cwb.json`
- Test: `tests/extract.test.mjs`

**Interfaces:**
- Consumes: raw Amadeus Flight Offers Search response body (`{data: [offer...]}`).
- Produces:
  - `parseDurationMin(iso: "PT32H50M") -> number` (minutes; handles missing H or M part)
  - `OfferSummary` type used by Tasks 6, 7, 9: `{ priceAud2pax: number, validating: string, carriers: string[], outRoute: string[], backRoute: string[], outStops: number, outDurationMin: number }`
  - `offerSummary(offer) -> OfferSummary`
  - `extractSearch(body, {latamCarriers, idealRoutePath, dest}) -> {cheapest: OfferSummary|null, cheapestLatam: OfferSummary|null, idealRoute: OfferSummary|null}` — LATAM = `validating` in `latamCarriers`; idealRoute = cheapest LATAM-validating offer whose `outRoute` deep-equals `idealRoutePath` (only checked when `dest === idealRoutePath.at(-1)`; the spec's ideal-route card is explicitly the LATAM itinerary, so non-LATAM offers on the same path do not qualify); empty/missing `body.data` → all three null.

- [ ] **Step 1: Create the fixture**

`tests/fixtures/amadeus-cwb.json` — a trimmed but structurally faithful Flight Offers Search response with exactly 3 offers (only fields we read; real responses carry more, which must be ignored):

```json
{
  "data": [
    {
      "id": "1",
      "price": { "currency": "AUD", "grandTotal": "3480.10" },
      "validatingAirlineCodes": ["QF"],
      "itineraries": [
        {
          "duration": "PT29H45M",
          "segments": [
            { "departure": { "iataCode": "BNE" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "QF" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "QF" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "CWB" }, "carrierCode": "LA" }
          ]
        },
        {
          "duration": "PT31H10M",
          "segments": [
            { "departure": { "iataCode": "CWB" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "QF" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "BNE" }, "carrierCode": "QF" }
          ]
        }
      ]
    },
    {
      "id": "2",
      "price": { "currency": "AUD", "grandTotal": "3765.40" },
      "validatingAirlineCodes": ["LA"],
      "itineraries": [
        {
          "duration": "PT30H05M",
          "segments": [
            { "departure": { "iataCode": "BNE" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "CWB" }, "carrierCode": "LA" }
          ]
        },
        {
          "duration": "PT33H20M",
          "segments": [
            { "departure": { "iataCode": "CWB" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "BNE" }, "carrierCode": "LA" }
          ]
        }
      ]
    },
    {
      "id": "3",
      "price": { "currency": "AUD", "grandTotal": "3610.00" },
      "validatingAirlineCodes": ["LA"],
      "itineraries": [
        {
          "duration": "PT36H15M",
          "segments": [
            { "departure": { "iataCode": "BNE" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "GRU" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "GRU" }, "arrival": { "iataCode": "CWB" }, "carrierCode": "JJ" }
          ]
        },
        {
          "duration": "PT35H00M",
          "segments": [
            { "departure": { "iataCode": "CWB" }, "arrival": { "iataCode": "GRU" }, "carrierCode": "JJ" },
            { "departure": { "iataCode": "GRU" }, "arrival": { "iataCode": "SCL" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SCL" }, "arrival": { "iataCode": "SYD" }, "carrierCode": "LA" },
            { "departure": { "iataCode": "SYD" }, "arrival": { "iataCode": "BNE" }, "carrierCode": "LA" }
          ]
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/extract.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```js
// scripts/lib/extract.mjs
export function parseDurationMin(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function routeOf(itinerary) {
  const segs = itinerary.segments;
  return [segs[0].departure.iataCode, ...segs.map((s) => s.arrival.iataCode)];
}

export function offerSummary(offer) {
  const [out, back] = offer.itineraries;
  const carriers = [];
  for (const it of offer.itineraries) {
    for (const s of it.segments) {
      if (!carriers.includes(s.carrierCode)) carriers.push(s.carrierCode);
    }
  }
  return {
    priceAud2pax: Number(offer.price.grandTotal),
    validating: offer.validatingAirlineCodes?.[0] ?? "",
    carriers,
    outRoute: routeOf(out),
    backRoute: back ? routeOf(back) : [],
    outStops: out.segments.length - 1,
    outDurationMin: parseDurationMin(out.duration),
  };
}

function cheapestOf(summaries) {
  return summaries.length
    ? summaries.reduce((a, b) => (b.priceAud2pax < a.priceAud2pax ? b : a))
    : null;
}

export function extractSearch(body, { latamCarriers, idealRoutePath, dest }) {
  const all = (body?.data ?? []).map(offerSummary);
  const latam = all.filter((s) => latamCarriers.includes(s.validating));
  const ideal =
    dest === idealRoutePath.at(-1)
      ? all.filter((s) => latamCarriers.includes(s.validating) && JSON.stringify(s.outRoute) === JSON.stringify(idealRoutePath))
      : [];
  return { cheapest: cheapestOf(all), cheapestLatam: cheapestOf(latam), idealRoute: cheapestOf(ideal) };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/extract.test.mjs` — expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/extract.mjs tests/extract.test.mjs tests/fixtures/amadeus-cwb.json
git commit -m "feat: extract cheapest, LATAM, and ideal-route offers from Amadeus responses"
```

---

### Task 5: Amadeus client — `scripts/lib/amadeus.mjs`

**Files:**
- Create: `scripts/lib/amadeus.mjs`
- Test: `tests/amadeus.test.mjs`

**Interfaces:**
- Produces: `class AmadeusClient { constructor({clientId, clientSecret, env = "test", fetchImpl = fetch, sleepImpl}) ; async searchFlightOffers({origin, dest, depDate, retDate, adults, currency, maxOffers}) -> parsed body }`
  - OAuth token fetched lazily on first search, cached for the process lifetime.
  - Retries 429/5xx up to 3 attempts total with backoff (2s, 8s via injectable `sleepImpl`); throws `Error` with status after final failure. 4xx other than 429 throws immediately.
- Consumed by: Task 7 (`fetch.mjs`).

- [ ] **Step 1: Write the failing tests (mock fetch, no network)**

```js
// tests/amadeus.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/amadeus.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/lib/amadeus.mjs
const BASES = { test: "https://test.api.amadeus.com", production: "https://api.amadeus.com" };
const BACKOFF_MS = [2000, 8000];

export class AmadeusClient {
  constructor({ clientId, clientSecret, env = "test", fetchImpl = fetch, sleepImpl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.base = BASES[env] ?? BASES.test;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.accessToken = null;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    const res = await this.fetchImpl(`${this.base}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status} ${await res.text()}`);
    this.accessToken = (await res.json()).access_token;
    return this.accessToken;
  }

  async searchFlightOffers({ origin, dest, depDate, retDate, adults, currency, maxOffers }) {
    const url = new URL(`${this.base}/v2/shopping/flight-offers`);
    url.searchParams.set("originLocationCode", origin);
    url.searchParams.set("destinationLocationCode", dest);
    url.searchParams.set("departureDate", depDate);
    url.searchParams.set("returnDate", retDate);
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("currencyCode", currency);
    url.searchParams.set("max", String(maxOffers));

    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 3) {
        throw new Error(`Amadeus search failed: ${res.status} ${await res.text()}`);
      }
      await this.sleepImpl(BACKOFF_MS[attempt - 1]);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/amadeus.test.mjs` — expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/amadeus.mjs tests/amadeus.test.mjs
git commit -m "feat: Amadeus OAuth client with retry/backoff, injectable fetch"
```

---

### Task 6: Aggregation — `scripts/lib/aggregate.mjs`

**Files:**
- Create: `scripts/lib/aggregate.mjs`
- Test: `tests/aggregate.test.mjs`

**Interfaces:**
- Consumes: history records (Task 7 writes them): `{ts, origin, dest, depDate, retDate, tripDays, status: "ok"|"empty"|"error", cheapest: OfferSummary|null, cheapestLatam: OfferSummary|null, idealRoute: OfferSummary|null, error?: string}` and `OfferSummary` from Task 4.
- Produces:
  - `pairKey(r) -> "CWB|2027-02-06|2027-03-14"`
  - `deriveDaily(records, now: Date) -> {generatedAt, pairs: {[pairKey]: {[utcDay]: minPrice}}, bestPerDay: {[dest]: {[utcDay]: minPrice}}}`
  - `deriveLatest(records, {config, budget, sweepCursor, now}) -> latestJson` with the exact shape seeded in Task 1:
    - `pinned[dest]` = newest ok/empty record for the configured pinned pair (`{ts, depDate, retDate, cheapest, cheapestLatam}`) or absent.
    - `deltas[dest]` = `{vsYesterdayAud, vs7dAud}`: current pinned cheapest price minus that pair's daily min 1 / 7 UTC days before `now`; `null` when either side missing.
    - `idealRoute` = `{latest, latestTs, lastSeen}`: `latest` from the newest CWB pinned-pair record (null if that record has none); `lastSeen` = `{offer, ts, depDate, retDate}` from the newest record anywhere with a non-null idealRoute, else null.
    - `bestInWindow[dest]` = `{priceAud2pax, depDate, retDate, tripDays, ts}` — lowest cheapest price among each pair's **most recent** ok record (current best, not historical).
    - `allTimeLow[dest]` = `{priceAud2pax, ts, depDate, retDate}` across all ok records ever.
    - `alert` = `{active, priceAud2pax, targetAud2pax}` — active when any current pinned cheapest ≤ target; `priceAud2pax` is that lowest qualifying price.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/aggregate.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/lib/aggregate.mjs
export function pairKey(r) {
  return `${r.dest}|${r.depDate}|${r.retDate}`;
}

const day = (ts) => ts.slice(0, 10);
const byTsAsc = (a, b) => (a.ts < b.ts ? -1 : 1);

export function deriveDaily(records, now) {
  const pairs = {};
  const bestPerDay = {};
  for (const r of records) {
    if (r.status !== "ok" || !r.cheapest) continue;
    const k = pairKey(r);
    const d = day(r.ts);
    const p = r.cheapest.priceAud2pax;
    pairs[k] ??= {};
    pairs[k][d] = Math.min(pairs[k][d] ?? Infinity, p);
    bestPerDay[r.dest] ??= {};
    bestPerDay[r.dest][d] = Math.min(bestPerDay[r.dest][d] ?? Infinity, p);
  }
  return { generatedAt: now.toISOString(), pairs, bestPerDay };
}

function daysAgo(now, n) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function deriveLatest(records, { config, budget, sweepCursor, now }) {
  const sorted = [...records].sort(byTsAsc);
  const daily = deriveDaily(records, now);
  const { depDate, retDate } = config.pinned;

  const pinned = {};
  const deltas = {};
  for (const dest of config.destinations) {
    const key = `${dest}|${depDate}|${retDate}`;
    const recs = sorted.filter((r) => pairKey(r) === key && r.status !== "error");
    const cur = recs.at(-1);
    if (!cur) continue;
    pinned[dest] = { ts: cur.ts, depDate, retDate, cheapest: cur.cheapest, cheapestLatam: cur.cheapestLatam };
    const price = cur.cheapest?.priceAud2pax ?? null;
    const diff = (n) => {
      const past = daily.pairs[key]?.[daysAgo(now, n)];
      return price != null && past != null ? Math.round((price - past) * 100) / 100 : null;
    };
    deltas[dest] = { vsYesterdayAud: diff(1), vs7dAud: diff(7) };
  }

  const cwbPinned = pinned[config.idealRoutePath.at(-1)];
  const seen = sorted.filter((r) => r.idealRoute).at(-1);
  const idealRoute = {
    latest: cwbPinned ? sorted.filter((r) => pairKey(r) === `${config.idealRoutePath.at(-1)}|${depDate}|${retDate}` && r.status !== "error").at(-1)?.idealRoute ?? null : null,
    latestTs: cwbPinned?.ts ?? null,
    lastSeen: seen ? { offer: seen.idealRoute, ts: seen.ts, depDate: seen.depDate, retDate: seen.retDate } : null,
  };

  const bestInWindow = {};
  const allTimeLow = {};
  for (const dest of config.destinations) {
    const ok = sorted.filter((r) => r.dest === dest && r.status === "ok" && r.cheapest);
    const currentPerPair = new Map();
    for (const r of ok) currentPerPair.set(pairKey(r), r); // ascending ts -> ends newest
    const currents = [...currentPerPair.values()];
    if (currents.length) {
      const b = currents.reduce((a, r) => (r.cheapest.priceAud2pax < a.cheapest.priceAud2pax ? r : a));
      bestInWindow[dest] = { priceAud2pax: b.cheapest.priceAud2pax, depDate: b.depDate, retDate: b.retDate, tripDays: b.tripDays, ts: b.ts };
    }
    if (ok.length) {
      const lo = ok.reduce((a, r) => (r.cheapest.priceAud2pax < a.cheapest.priceAud2pax ? r : a));
      allTimeLow[dest] = { priceAud2pax: lo.cheapest.priceAud2pax, ts: lo.ts, depDate: lo.depDate, retDate: lo.retDate };
    }
  }

  const pinnedPrices = Object.values(pinned).map((p) => p.cheapest?.priceAud2pax).filter((p) => p != null);
  const qualifying = pinnedPrices.filter((p) => p <= config.targetPriceAud2pax);
  const alert = {
    active: qualifying.length > 0,
    priceAud2pax: qualifying.length ? Math.min(...qualifying) : null,
    targetAud2pax: config.targetPriceAud2pax,
  };

  return { updatedAt: now.toISOString(), sweepCursor, budget, pinned, deltas, idealRoute, bestInWindow, allTimeLow, alert };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/aggregate.test.mjs` — expected: PASS (2 tests). Also run the full suite: `npm test` — expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/aggregate.mjs tests/aggregate.test.mjs
git commit -m "feat: derive daily minima and latest snapshot from history"
```

---

### Task 7: Fetch driver — `scripts/fetch.mjs`

**Files:**
- Create: `scripts/fetch.mjs`
- Test: `tests/fetch.test.mjs`

**Interfaces:**
- Consumes: everything above. CLI: `node scripts/fetch.mjs --mode pinned|sweep [--dataDir data] [--configPath config.json]`. Env: `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_ENV`, optional `GITHUB_OUTPUT`.
- Produces: `runFetch({mode, dataDir, configPath, client, now}) -> {records, latest}` exported for tests; appends to `history.jsonl`, rewrites `daily.json`/`latest.json`; writes `alert=true` to `$GITHUB_OUTPUT` only on a false→true alert crossing.

- [ ] **Step 1: Write the failing tests (fake client, temp dir)**

```js
// tests/fetch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFetch } from "../scripts/fetch.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/amadeus-cwb.json", import.meta.url)));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bf-"));
  cpSync(new URL("../data", import.meta.url).pathname, join(dir, "data"), { recursive: true });
  return dir;
}

const fakeClient = (log = []) => ({
  searchFlightOffers: async (params) => {
    log.push(params);
    if (params.dest === "GRU") throw new Error("Amadeus search failed: 500");
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
  assert.equal(latest.pinned.CWB.cheapest.priceAud2pax, 3480.1);
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
  assert.equal(log.length, 30); // sweep.dailyCallBudget
  assert.equal(latest.sweepCursor, 30);
});

test("budget exhaustion stops before searching", async () => {
  const dir = setup();
  const seeded = JSON.parse(readFileSync(join(dir, "data/latest.json"), "utf8"));
  seeded.budget = { month: "2026-08", callsUsed: 1950, cap: 1950 };
  writeFileSync(join(dir, "data/latest.json"), JSON.stringify(seeded));
  const log = [];
  const { records } = await runFetch({
    mode: "pinned", dataDir: join(dir, "data"), configPath: new URL("../config.json", import.meta.url).pathname,
    client: fakeClient(log), now: new Date("2026-08-17T02:00:00Z"),
  });
  assert.equal(log.length, 0);
  assert.equal(records.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/fetch.test.mjs` — expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// scripts/fetch.mjs
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { sweepGrid, nextSweepBatch, daysBetween } from "./lib/dates.mjs";
import { normalizeBudget, remainingCalls, recordCalls } from "./lib/budget.mjs";
import { extractSearch } from "./lib/extract.mjs";
import { deriveDaily, deriveLatest } from "./lib/aggregate.mjs";
import { AmadeusClient } from "./lib/amadeus.mjs";

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

  let units;
  if (mode === "pinned") {
    const { depDate, retDate } = config.pinned;
    units = config.destinations.map((dest) => ({ dest, depDate, retDate, tripDays: daysBetween(depDate, retDate) }));
  } else if (mode === "sweep") {
    const grid = sweepGrid(config);
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
    if (mode === "sweep") sweepCursor = (prevLatest.sweepCursor + allowed) % sweepGrid(config).length;
  }

  const records = [];
  for (const u of units) {
    const base = { ts: now.toISOString(), origin: config.origin, ...u };
    try {
      const body = await client.searchFlightOffers({
        origin: config.origin, dest: u.dest, depDate: u.depDate, retDate: u.retDate,
        adults: config.adults, currency: config.currency, maxOffers: config.maxOffers,
      });
      const ex = extractSearch(body, { latamCarriers: config.latamCarriers, idealRoutePath: config.idealRoutePath, dest: u.dest });
      records.push({ ...base, status: ex.cheapest ? "ok" : "empty", ...ex });
    } catch (err) {
      records.push({ ...base, status: "error", cheapest: null, cheapestLatam: null, idealRoute: null, error: String(err.message ?? err) });
    }
  }
  budget = recordCalls(budget, units.length);

  for (const r of records) appendFileSync(historyPath, JSON.stringify(r) + "\n");
  const history = readHistory(historyPath);
  const daily = deriveDaily(history, now);
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
  const client = new AmadeusClient({
    clientId: process.env.AMADEUS_CLIENT_ID,
    clientSecret: process.env.AMADEUS_CLIENT_SECRET,
    env: process.env.AMADEUS_ENV || "test",
  });
  runFetch({ mode: values.mode, dataDir: values.dataDir, configPath: values.configPath, client, now: new Date() })
    .catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test` — expected: all suites PASS (dates, budget, extract, amadeus, aggregate, fetch).

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch.mjs tests/fetch.test.mjs
git commit -m "feat: fetch driver with modes, budget guard, alert crossing output"
```

---

### Task 8: GitHub Actions workflows

**Files:**
- Create: `.github/workflows/pinned.yml`, `.github/workflows/sweep.yml`, `.github/workflows/test.yml`

**Interfaces:**
- Consumes: `scripts/fetch.mjs` CLI (Task 7), secrets `AMADEUS_CLIENT_ID`/`AMADEUS_CLIENT_SECRET`, repo variable `AMADEUS_ENV`.
- Produces: hourly/daily data commits to `main`; GitHub issue on alert crossing.

- [ ] **Step 1: Write pinned.yml**

```yaml
name: pinned
on:
  schedule:
    - cron: "0 20-23,0-12 * * *" # hourly 06:00-22:00 Brisbane (UTC+10)
  workflow_dispatch:
concurrency:
  group: fetch
  cancel-in-progress: false
permissions:
  contents: write
  issues: write
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - id: fetch
        run: node scripts/fetch.mjs --mode pinned
        env:
          AMADEUS_CLIENT_ID: ${{ secrets.AMADEUS_CLIENT_ID }}
          AMADEUS_CLIENT_SECRET: ${{ secrets.AMADEUS_CLIENT_SECRET }}
          AMADEUS_ENV: ${{ vars.AMADEUS_ENV || 'test' }}
      - name: Commit data
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/
          git diff --cached --quiet && echo "no changes" && exit 0
          git commit -m "data: pinned fetch $(date -u +%FT%TZ)"
          for i in 1 2 3; do
            git push && exit 0
            git pull --rebase && sleep 3
          done
          exit 1
      - name: Price alert issue
        if: steps.fetch.outputs.alert == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh issue create \
            --title "✈️ Price alert: A\$${{ steps.fetch.outputs.alert_price }} for 2 pax (target hit)" \
            --body "The pinned BNE→Brazil round trip dropped to **A\$${{ steps.fetch.outputs.alert_price }}** for 2 passengers. Check the dashboard." \
            --repo "$GITHUB_REPOSITORY"
```

- [ ] **Step 2: Write sweep.yml**

Identical to `pinned.yml` except: `name: sweep`, cron `"30 13 * * *"` (23:30 Brisbane), run line `node scripts/fetch.mjs --mode sweep`, commit message prefix `data: sweep`. Same concurrency group `fetch` so pinned and sweep never push concurrently. Copy the full file — do not reference-share YAML.

- [ ] **Step 3: Write test.yml (CI for pushes/PRs)**

```yaml
name: test
on:
  push:
    paths: ["scripts/**", "tests/**", "config.json", "package.json"]
  workflow_dispatch:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
```

- [ ] **Step 4: Sanity-check YAML parses**

Run: `node -e "const fs=require('fs');for(const f of ['pinned','sweep','test']){const y=fs.readFileSync('.github/workflows/'+f+'.yml','utf8');if(!/^name:/m.test(y))throw f}console.log('ok')"` — expected: `ok`. (Real validation happens on GitHub after Task 10's push; both fetch workflows support `workflow_dispatch` for that.)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: pinned hourly, sweep daily, and test workflows"
```

---

### Task 9: Dashboard — `index.html` + `assets/`

**Files:**
- Create: `index.html`, `assets/style.css`, `assets/app.js`

**Interfaces:**
- Consumes: `data/latest.json`, `data/daily.json`, `data/history.jsonl` (fetched relative to page URL) — exact shapes from Tasks 1/6/7. Must handle the seeded empty state (`updatedAt: null`) with a friendly "waiting for first fetch" screen.
- Produces: the complete user-facing dashboard.

**REQUIRED SUB-SKILLS for this task:** load `dataviz` before writing any chart/heatmap code, and `frontend-design:frontend-design` before writing the page — standalone travel-dashboard look (per spec: NOT Karmo/Drift branded), mobile-first.

- [ ] **Step 1: Build `index.html` skeleton**

Semantic sections with these exact IDs (app.js targets them): `#hero` (pinned price cards for CWB + GRU with deltas and all-time low), `#ideal-route` (LATAM BNE→SYD→SCL→CWB card incl. explicit not-found state), `#trend` (canvas for Chart.js), `#heatmap` (CSS-grid calendar), `#offers` (latest offers table + filters), `#meta` (freshness chip, budget gauge, target-price alert banner, Google Flights link, CSV export button). Chart.js loaded via `<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>`.

- [ ] **Step 2: Implement `assets/app.js` data layer + rendering**

Core logic (styling free, logic fixed):

```js
async function loadData() {
  const [latest, daily] = await Promise.all([
    fetch("data/latest.json").then((r) => r.json()),
    fetch("data/daily.json").then((r) => r.json()),
  ]);
  return { latest, daily };
}

const aud = (n) => n == null ? "—" : "A$" + Math.round(n).toLocaleString("en-AU");
const delta = (n) => n == null ? "" : (n <= 0 ? "▼ " : "▲ ") + aud(Math.abs(n));

function googleFlightsUrl(dest, depDate, retDate) {
  const q = `Flights from BNE to ${dest} on ${depDate} through ${retDate} for 2 passengers`;
  return "https://www.google.com/travel/flights?q=" + encodeURIComponent(q);
}

// Heatmap: rows = Feb departure days, cols = trip lengths; value = latest
// known price per pair from daily.pairs (most recent day key per pair).
function latestPairPrices(daily, dest) {
  const out = {};
  for (const [key, days] of Object.entries(daily.pairs)) {
    if (!key.startsWith(dest + "|")) continue;
    const lastDay = Object.keys(days).sort().at(-1);
    out[key] = days[lastDay];
  }
  return out;
}
```

Rendering requirements: hero deltas colored (down = good); ideal-route card shows route as `BNE → SYD → SCL → CWB`, price, and a sparkline (inline SVG polyline over that pair's `daily.pairs` series); trend chart = daily min lines for pinned-CWB, pinned-GRU, best-per-day-CWB, best-per-day-GRU from `daily`; heatmap cells colored on a sequential scale (per dataviz skill), tap/click shows pair details + its Google Flights link; offers table from `latest.pinned` + `latest.bestInWindow` with LATAM badge on rows whose `validating` is a LATAM code; CSV export fetches `data/history.jsonl` on demand and downloads flattened rows via a Blob link; alert banner when `latest.alert.active`; budget gauge `callsUsed/cap`; freshness chip from `updatedAt` ("updated 12 min ago", red if > 3 h during Brisbane daytime).

- [ ] **Step 3: Style `assets/style.css`**

Per frontend-design skill: mobile-first single column, cards, distinctive standalone travel identity, dark-mode friendly via `prefers-color-scheme`. Wide tables/heatmap scroll horizontally inside their container.

- [ ] **Step 4: Verify locally with seeded fake data**

Create a throwaway git-ignored fixture: temporarily copy 20–30 handcrafted history lines (reuse the fixture offers, vary ts/prices across 5 days and a few date pairs) into `data/history.jsonl`, run `node -e` snippet to regenerate `daily.json`/`latest.json` via `deriveDaily`/`deriveLatest`, then `python3 -m http.server 8080` and check `curl -s localhost:8080 | grep -c section` ≥ 5 and manually open http://localhost:8080 to verify all six sections render, including the empty-state path (`git stash` the fake data, reload, expect "waiting for first fetch"). Restore seed data files (`git checkout data/`) afterwards.

- [ ] **Step 5: Commit**

```bash
git add index.html assets/
git commit -m "feat: dashboard with hero, ideal-route card, trend chart, heatmap, offers, extras"
```

---

### Task 10: Deploy & go-live

**Files:**
- Modify: `README.md` (real dashboard URL)

**Interfaces:**
- Consumes: user-supplied Amadeus API Key + Secret (BLOCKING: ask the user to create a free account at https://developers.amadeus.com → My Self-Service Workspace → Create app → copy API Key & Secret).

- [ ] **Step 1: Create the public GitHub repo and push**

```bash
gh repo create brazil-flights --public --source . --push
```

- [ ] **Step 2 (BLOCKING): Get Amadeus credentials from the user, then set secrets**

```bash
gh secret set AMADEUS_CLIENT_ID --body "<key>"
gh secret set AMADEUS_CLIENT_SECRET --body "<secret>"
gh variable set AMADEUS_ENV --body "test"
```
Never echo the secret values into logs or files.

- [ ] **Step 3: Enable branch Pages (main, root)**

```bash
gh api -X POST repos/{owner}/brazil-flights/pages -f build_type=legacy -f "source[branch]=main" -f "source[path]=/" || \
gh api -X PUT repos/{owner}/brazil-flights/pages -f build_type=legacy -f "source[branch]=main" -f "source[path]=/"
```

- [ ] **Step 4: First live run + verify end-to-end**

```bash
gh workflow run pinned && sleep 90 && gh run list --workflow pinned --limit 1
```
Expected: run concludes success and a `data: pinned fetch …` commit lands. If the run shows `status: empty` rows for both destinations, the Amadeus **test** env lacks this route — tell the user, switch `AMADEUS_ENV` variable to `production` (needs production keys from the same Amadeus app, still free allowance) and re-run. Then fetch the live page: `curl -sI https://<owner>.github.io/brazil-flights/` expecting `200`, and confirm `https://<owner>.github.io/brazil-flights/data/latest.json` shows the new `updatedAt`.

- [ ] **Step 5: Update README with the live URL and commit**

```bash
git add README.md && git commit -m "docs: add live dashboard URL" && git push
```

---

## Self-Review Notes

- Spec coverage: pipeline (T2–T8), storage shapes (T1/T6/T7), all six dashboard sections + extras (T9), alerts (T7 output + T8 issue step), error handling (T5 retries, T7 error rows + validation, T8 concurrency/push retry), testing (T2–T7 fixtures-only), setup (T10). Spec's `site/` folder replaced by root serving — recorded in Global Constraints with rationale.
- Type consistency: `OfferSummary` fields identical across T4/T6/T9; `latest.json` shape identical in T1 seed, T6 producer, T9 consumer; budget object `{month, callsUsed, cap}` everywhere.
- Known accepted simplifications: retries may consume extra Amadeus quota beyond the counter (rare; cap has 50-call headroom); daily aggregation uses UTC days; deltas need an exact prior-day data point (else null).
