# Brazil Flights Price Tracker — Design Spec

**Date:** 2026-08-17
**Status:** Approved design, pending implementation plan

## Overview

A free, self-hosted web dashboard that tracks round-trip flight prices from
Brisbane (BNE) to Brazil for 2 passengers, departing February 2027 and
returning March 2027 with a minimum trip length of 30 days. Prices update
automatically during the day, a full price history is kept forever, and the
dashboard is optimized for an at-a-glance read on any device.

The user currently price-checks manually on Google Flights. Google Flights has
no public API, so pricing comes from the Amadeus Self-Service API (free tier),
with a one-tap deep link to Google Flights for verification before booking.

## Goals

- Track BNE → Curitiba (CWB) and BNE → São Paulo (GRU) round trips, 2 adults,
  economy, priced in AUD.
- Date window: depart any day in Feb 2027, return any day in Mar 2027,
  return − departure ≥ 30 days.
- Prefer LATAM; specifically surface the ideal routing
  BNE → SYD → SCL (Santiago) → CWB whenever it exists, while still showing all
  other airlines/options.
- Keep a permanent daily/hourly price history and show trends.
- Automatic updates: hourly during Brisbane waking hours for pinned dates.
- Total cost: $0 (free API tier, free hosting, hard budget guard).

## Non-goals (YAGNI)

User accounts, other origin airports, non-economy cabins, currencies other
than AUD, push notifications beyond GitHub's built-in issue email, paid API
tiers, exhaustive coverage of every one of the ~434 valid date pairs.

## Architecture

**Stack:** GitHub public repo + GitHub Actions (scheduled fetch jobs) +
GitHub Pages (static dashboard). No servers, no database.

```
┌────────────────────────── GitHub repo ──────────────────────────┐
│  config.json          ← user-editable settings                  │
│  scripts/fetch.mjs    ← Node fetch/transform (unit-tested)      │
│  .github/workflows/   ← hourly + daily cron jobs                │
│  data/history.jsonl   ← append-only price log                   │
│  data/daily.json      ← derived daily minimums                  │
│  data/latest.json     ← current snapshot for the dashboard      │
│  site/                ← static dashboard (GitHub Pages)         │
└──────────────────────────────────────────────────────────────────┘
         ▲ cron (Actions)                      ▼ HTTPS
   Amadeus Self-Service API            Browser (dashboard)
```

Each scheduled run: authenticate to Amadeus (OAuth2 client-credentials),
run its searches, append results to `data/history.jsonl`, regenerate
`data/daily.json` and `data/latest.json`, validate all JSON, commit and push.
The commit triggers a GitHub Pages redeploy, so the site is always current.
Amadeus API key/secret live in encrypted GitHub Actions secrets.

## Data pipeline & API budget

Amadeus free tier ≈ 2,000 Flight Offers Search calls/month (~66/day).
Budget split, all tunable in `config.json`:

### Hourly pinned job
- Cron: hourly 06:00–22:00 Brisbane time (UTC cron `0 20-23,0-12 * * *`),
  17 runs/day. Overnight runs are skipped to save quota.
- Each run: pinned date pair × {CWB, GRU} = 2 searches.
- Initial pinned pair: depart **Sat 2027-02-06**, return **Sun 2027-03-14**
  (36 days). Editable in `config.json`.
- ≈ 34 calls/day.

### Daily sweep job
- Once a day, ~30 calls, rotating through a sampled grid:
  - Departures: every 2nd day of Feb 2027 (Feb 1, 3, … 27 → 14 days).
  - Trip lengths: 30, 33, 37, 41, 45 days.
  - Combos with a return after Mar 31 are filtered out (~65 valid combos).
  - × 2 destinations ≈ 130 searches → full grid refreshes every ~5 days.
- A cursor in `data/latest.json` tracks sweep position between runs.

### Budget guard
- ≈ 64 calls/day ≈ 1,920/month. A per-month counter is persisted in the data
  files; the script hard-stops before exceeding `config.monthlyCallBudget`
  (default 1,950). Exhaustion is shown on the dashboard, never billed.

### Per-search extraction
From each Flight Offers Search response (adults=2, currencyCode=AUD,
max offers ~20), record:
1. **Cheapest offer overall** — grand total for 2 pax, validating airline,
   marketing carriers, stop count, total duration, full segment route.
2. **Cheapest LATAM offer** — same fields, filtered to LATAM group carriers
   (LA/JJ/4M/XL etc.).
3. **Ideal-route match** — cheapest LATAM-validated offer whose outbound
   path matches BNE → SYD → SCL → CWB (flagged specially; a non-LATAM
   offer on the same path counts only toward "cheapest overall").
Any of 2–3 may be absent; that is recorded explicitly, not silently dropped.

### Environment caveat
Amadeus *test* environment can have thin data for BNE–South America routes.
Implementation starts on test keys; if searches come back empty, the same
code switches to production keys (which also carry a free monthly allowance;
the budget guard keeps usage inside it).

## Data model

- **`data/history.jsonl`** — append-only; one JSON line per (run × destination
  × date pair): `ts`, `origin`, `dest`, `depDate`, `retDate`, `tripDays`,
  `cheapest {priceAud2pax, carriers, stops, durationMin, route}`,
  `cheapestLatam {…}` | null, `idealRoute {…}` | null,
  `status: ok | empty | error`.
- **`data/daily.json`** — per date-pair per day minimums, plus all-time low
  and 7-day stats; regenerated from history each run.
- **`data/latest.json`** — current best offers, deltas vs yesterday/7 days,
  freshness timestamp, sweep cursor, monthly call counter.
- **`config.json`** — pinned pair, destinations, sweep grid params, monthly
  budget, target price for alerts, LATAM carrier codes, ideal-route path.

## Dashboard (static site)

Single mobile-friendly page, standalone custom travel-dashboard design (not
Karmo/Drift branded). Reads `latest.json` first, lazy-loads the rest.

1. **Hero strip** — best current price for 2 pax on the pinned dates, CWB and
   GRU side by side; delta vs yesterday and vs 7 days ago; all-time low with
   its date.
2. **Ideal route card** — highlighted LATAM BNE→SYD→SCL→CWB card with price +
   sparkline when present; explicit "not found in latest data" state when not.
3. **Trend chart** — daily minimum lines: pinned-CWB, pinned-GRU, and cheapest
   anywhere in the window.
4. **Calendar heatmap** — Feb departure day × trip length, colored by price,
   from sweep data; tapping a cell shows that pair's details/history.
5. **Offers table** — latest results with airline, stops, duration, price;
   LATAM rows badged; ideal route pinned on top; filter by airline/stops.
6. **Extras** — Google Flights deep link with dates prefilled; target-price
   alert banner; "updated X min ago" freshness chip; monthly API budget
   gauge; CSV export of full history.

**Alerts:** when a tracked price ≤ `config.targetPriceAud2pax`, the Action
opens a GitHub issue (deduplicated — one open issue per crossing), which
GitHub emails to the user for free; the dashboard shows a matching banner.

## Error handling

- Single fetch module: OAuth token per run, retry with exponential backoff on
  429/5xx, per-search try/catch.
- Failed searches are recorded as `status: error` rows — visible gaps, not
  crashes; the workflow still commits successfully gathered data.
- All JSON validated before commit; a malformed response can never corrupt
  the published site.
- Budget exhausted → fetching stops, dashboard keeps last data with a notice.
- Concurrent-run protection via Actions `concurrency` group.

## Testing

- Unit tests (Node built-in test runner) for: sweep-grid generation incl. the
  ≥30-day and ≤Mar-31 constraints, LATAM/ideal-route matching, price
  extraction from recorded Amadeus fixture responses, budget accounting,
  daily-aggregate derivation.
- No live API calls in tests; fixtures only.
- `workflow_dispatch` manual trigger for on-demand end-to-end runs.

## Setup (one-time)

1. **User:** create a free Amadeus for Developers account
   (developers.amadeus.com, no credit card) and provide API Key + Secret.
2. **Claude:** create public GitHub repo, add secrets, enable Pages, push
   code, run the first fetch, verify the dashboard.

## Amendment 2026-08-17: Amadeus decommissioned → SerpAPI

The Amadeus Self-Service API is dead, so the price source moves to
**SerpAPI's `google_flights` engine**. The original design above stands
except where noted here.

**Data source.** `scripts/lib/serpapi.mjs` replaces `scripts/lib/amadeus.mjs`.
A single `GET https://serpapi.com/search.json` per search
(`engine=google_flights`, `type=1` round trip, `gl=au`, `hl=en`) authenticated
by one `SERPAPI_API_KEY` secret — no OAuth token step. Retry policy is
unchanged (3 attempts, 2s/8s backoff on 429/5xx), plus two new cases: other
4xx throw immediately, and SerpAPI's habit of returning HTTP 200 with a
body-level `{"error": ...}` is treated as a failure. Because the key travels
in the query string, every error message is passed through a redactor so it
can never reach the Actions log.

**Extraction.** `extractSerpSearch` replaces `extractSearch` behind the same
`{cheapest, cheapestLatam, idealRoute}` contract, so `aggregate.mjs`, the
history schema and the dashboard are unchanged. Two honest losses of fidelity:

- Google publishes no *validating carrier*, so "is this a LATAM itinerary?" is
  approximated per segment — every segment must carry a LATAM flight-number
  prefix or an airline name containing "LATAM". `validating` reports the first
  segment's marketing prefix.
- `backRoute` is always empty. The round-trip return leg is only retrievable
  via a second `departure_token` request, which would double the call cost for
  data the dashboard does not display.

**Cadence and budget.** The free tier allows 250 searches/month against
Amadeus' ~1950, a ~9x cut, so the schedule shrinks accordingly:

| | Before | After |
|---|---|---|
| Pinned | hourly, 06:00–22:00 Brisbane | twice daily, 08:00 & 20:00 Brisbane |
| Sweep grid | 108 units (Feb 1–27 step 2 × 5 lengths) | 34 units (Feb 1–25 step 4 × 3 lengths) |
| Sweep batch | 30/day | 4/day |
| Monthly cap | 1950 | 235 |

At 4 pinned + 4 sweep calls a day the nominal spend is 240 in a 30-day month
and 248 in a 31-day one. The cap is deliberately set *below* both, at 235,
because retries are not counted against the counter — the 15-call gap to the
real 250/month limit is slack for 429/5xx retry storms. The existing budget
guard absorbs the difference by trimming the last searches of the month
(logging a `::notice::` and advancing the sweep cursor by only the calls
actually made), which is the designed degradation. The full sweep grid now
recycles every ~8.5 days instead of ~3.6. The dashboard's freshness threshold
moves from 3h to 14h to match the twice-daily cadence, keeping the
Brisbane-daytime escalation rule.

**Testing.** `tests/fixtures/serpapi-cwb.json` replaces the Amadeus fixture,
modelling the same three-way discrimination (cheapest overall ≠ cheapest LATAM
≠ ideal route). Still no live API calls. `parseDurationMin` is gone — SerpAPI
reports durations as integer minutes, so the ISO-8601 parser had no caller.

**Setup change.** Step 1 of the original setup is now: create a free SerpAPI
account (serpapi.com, no credit card) and provide the private API key as the
`SERPAPI_API_KEY` repository secret.
