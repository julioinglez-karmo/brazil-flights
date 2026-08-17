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
