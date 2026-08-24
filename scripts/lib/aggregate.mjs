export function pairKey(r) {
  return `${r.dest}|${r.depDate}|${r.retDate}`;
}

const day = (ts) => ts.slice(0, 10);
const byTsAsc = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

// The id of the route the pre-redesign `idealRoute` field described. Rows written
// before 2026-08-24 carry a single `idealRoute` on the BNE→SYD→SCL→CWB path, which
// is exactly today's viaSyd watch. history.jsonl is append-only, so the shim is
// permanent: it is the only place old rows are taught the new vocabulary.
const LEGACY_IDEAL_ROUTE_ID = "viaSyd";

const samePath = (a, b) => a.length === b.length && a.every((code, i) => code === b[i]);

function normalizeRow(r, watchedRoutes) {
  if (r.routes) return r;
  const routes = {};
  for (const route of watchedRoutes) {
    // A legacy row recorded its cheapest offer's full outbound path. When that path IS a
    // watched path, that offer is provably also the cheapest ON the path — a global
    // minimum lying on the path is the path's minimum — so the slot is recovered exactly,
    // not estimated. Off-path, the row simply never measured the route: null means unknown.
    routes[route.id] = samePath(r.cheapest?.outRoute ?? [], route.path) ? r.cheapest : null;
  }
  // `idealRoute` is the fallback for its own slot, never an override: it was gated to
  // all-LATAM options, so it can only ever be the dearer quote on the very same path.
  // Only apply it when that slot is actually configured — otherwise a de-configured
  // route would grow a `routes.viaSyd` key that latest.json/daily.json never intend.
  if (r.idealRoute && watchedRoutes.some((route) => route.id === LEGACY_IDEAL_ROUTE_ID)) {
    routes[LEGACY_IDEAL_ROUTE_ID] ??= r.idealRoute;
  }
  return { ...r, routes };
}

/** `dest|depDate|retDate` for each tracked destination on the pinned dates. */
export function pinnedKeysOf(config) {
  const { depDate, retDate } = config.pinned;
  return config.destinations.map((dest) => `${dest}|${depDate}|${retDate}`);
}

/**
 * @param {object[]} records raw history rows, legacy or current
 * @param {Date} now
 * @param {{dests?: string[], pinnedKeys?: string[], watchedRoutes?: object[]}} [opts]
 *   `dests` limits the file to the destinations still tracked — history keeps dropped
 *   ones forever, daily.json is a view of the present. `pinnedKeys` restricts
 *   `routeDaily` to those pairs, so the per-route series stays comparable with the
 *   pinned-cheapest line on the chart; `watchedRoutes` lets legacy rows be normalized.
 */
export function deriveDaily(records, now, { dests = null, pinnedKeys = null, watchedRoutes = [] } = {}) {
  const pairs = {};
  const bestPerDay = {};
  const routeDaily = {};
  for (const raw of records) {
    if (dests !== null && !dests.includes(raw.dest)) continue;
    const r = normalizeRow(raw, watchedRoutes);
    const d = day(r.ts);

    if (r.status !== "error" && (pinnedKeys === null || pinnedKeys.includes(pairKey(r)))) {
      for (const [id, offer] of Object.entries(r.routes)) {
        if (!Number.isFinite(offer?.priceAud2pax)) continue;
        routeDaily[id] ??= {};
        routeDaily[id][d] = Math.min(routeDaily[id][d] ?? Infinity, offer.priceAud2pax);
      }
    }

    if (r.status !== "ok" || !r.cheapest) continue;
    const k = pairKey(r);
    const p = r.cheapest.priceAud2pax;
    pairs[k] ??= {};
    pairs[k][d] = Math.min(pairs[k][d] ?? Infinity, p);
    bestPerDay[r.dest] ??= {};
    bestPerDay[r.dest][d] = Math.min(bestPerDay[r.dest][d] ?? Infinity, p);
  }
  return { generatedAt: now.toISOString(), pairs, bestPerDay, routeDaily };
}

function daysAgo(now, n) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function deriveLatest(records, { config, budget, sweepCursor, now }) {
  const watchedRoutes = config.watchedRoutes ?? [];
  const sorted = records.map((r) => normalizeRow(r, watchedRoutes)).sort(byTsAsc);
  const daily = deriveDaily(records, now, { dests: config.destinations, watchedRoutes });
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

  // One slot per watched route. `current` is what the newest completed search on that
  // route's pinned pair returned — null means "searched, not offered", which is the
  // whole point of the via-SYD watch. `lastSeen` reaches across every pair and every
  // day, so a route that vanishes still shows what it last cost.
  const routes = {};
  for (const route of watchedRoutes) {
    const key = `${route.path.at(-1)}|${depDate}|${retDate}`;
    const cur = sorted.filter((r) => pairKey(r) === key && r.status !== "error").at(-1);
    const seen = sorted.filter((r) => r.routes[route.id]).at(-1);
    routes[route.id] = {
      label: route.label,
      role: route.role,
      current: cur?.routes[route.id] ?? null,
      currentTs: cur?.ts ?? null,
      lastSeen: seen
        ? { offer: seen.routes[route.id], ts: seen.ts, depDate: seen.depDate, retDate: seen.retDate }
        : null,
    };
  }

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

  return { updatedAt: now.toISOString(), sweepCursor, budget, pinned, deltas, routes, bestInWindow, allTimeLow, alert };
}
