// Southbound — BNE → Curitiba price tracker dashboard.
// Reads data/latest.json + data/daily.json (written by scripts/fetch.mjs) and
// renders six sections: hero, route watch, trend, heatmap, offers, meta.

/* ------------------------------------------------------------------ *
 * Core data layer
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * Constants — mirror config.json (the page is static, config is not fetched)
 * ------------------------------------------------------------------ */

const LATAM = new Set(["LA", "JJ", "XL", "LU", "LP", "PZ", "4C", "4M"]);

// The watched routes, mirroring config.json. latest.json carries each route's price
// and state under the same ids; the paths live here because the page is static and
// never fetches config. Keep the two in step.
const WATCHED = [
  { id: "viaMel", label: "via Melbourne", role: "primary", path: ["BNE", "MEL", "SCL", "CWB"] },
  { id: "viaSyd", label: "via Sydney", role: "watch", path: ["BNE", "SYD", "SCL", "CWB"] },
];
const PRIMARY = WATCHED.find((r) => r.role === "primary") ?? WATCHED[0];
const DEST = PRIMARY.path.at(-1);

const CITY = { CWB: "Curitiba", BNE: "Brisbane", MEL: "Melbourne", SYD: "Sydney", SCL: "Santiago" };
const AIRLINE = { LA: "LATAM", JJ: "LATAM Brasil", QF: "Qantas", VA: "Virgin Australia", NZ: "Air New Zealand", UA: "United", AA: "American", DL: "Delta", EK: "Emirates", QR: "Qatar Airways", SQ: "Singapore Airlines", AC: "Air Canada", AR: "Aerolíneas Argentinas", G3: "GOL", AD: "Azul", CM: "Copa", AM: "Aeroméxico", ET: "Ethiopian", SA: "South African", TP: "TAP", IB: "Iberia", AF: "Air France", KL: "KLM", BA: "British Airways" };
const STALE_HOURS = 14; // pinned runs three times daily (08:00 / 14:00 / 20:00 Brisbane)

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const utc = (isoDay) => Date.parse(isoDay + "T00:00:00Z");
const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / DAY_MS);

const dayFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short" });
const dayYearFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const stampFmt = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const fmtDay = (d) => (d ? dayFmt.format(new Date(utc(d))) : "—");
const fmtDayYear = (d) => (d ? dayYearFmt.format(new Date(utc(d))) : "—");
const fmtStamp = (ts) => (ts ? stampFmt.format(new Date(ts)) : "—");

function audCompact(n) {
  if (n == null) return "—";
  return n >= 1000 ? "A$" + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : aud(n);
}

function fmtDuration(min) {
  if (!min) return "—";
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

function ago(ts, now = Date.now()) {
  if (!ts) return { text: "never", hours: Infinity };
  const mins = Math.max(0, Math.round((now - Date.parse(ts)) / 60000));
  const hours = mins / 60;
  if (mins < 1) return { text: "just now", hours };
  if (mins < 60) return { text: `${mins} min ago`, hours };
  if (hours < 48) return { text: `${Math.round(hours)} h ago`, hours };
  return { text: `${Math.round(hours / 24)} d ago`, hours };
}

// Brisbane is UTC+10 year round (no daylight saving).
const brisbaneHour = (now = Date.now()) => new Date(now + 10 * 3600000).getUTCHours();
const isBrisbaneDaytime = (now = Date.now()) => { const h = brisbaneHour(now); return h >= 6 && h < 22; };

/* ------------------------------------------------------------------ *
 * DOM helpers — all data goes in as text nodes, never innerHTML
 * ------------------------------------------------------------------ */

function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isLatam = (code) => LATAM.has(code);

function routeStrip(codes, big = false) {
  const strip = h("div", { class: "strip" + (big ? " strip--lg" : ""), "aria-label": "Route: " + codes.join(", ") });
  codes.forEach((code, i) => {
    if (i) strip.append(h("i", { class: "strip-leg", "aria-hidden": "true", style: `--i:${i}` }));
    strip.append(h("span", { class: "strip-node", "aria-hidden": "true", style: `--i:${i}` }, code));
  });
  return strip;
}

// Colour follows the entity, not its rank: the cheapest-fare figures are blue
// wherever they appear, the primary watched route is gold on the cards and amber
// on the chart. Nothing is repainted when a series comes or goes.
const ENTITY = { cheapest: "--series-1", route: "--series-route" };
const seriesColor = (entity) => cssVar(ENTITY[entity]) || "#2568d2";

function deltaChip(label, n) {
  const cls = n == null ? "d--none" : n === 0 ? "d--flat" : n < 0 ? "d--good" : "d--bad";
  const text = n == null ? "no data" : n === 0 ? "no change" : delta(n);
  const said = n == null ? "no comparison data" : n === 0 ? "unchanged" : (n < 0 ? "down " : "up ") + aud(Math.abs(n));
  return h("li", { class: "d " + cls },
    h("span", { class: "d-label" }, label),
    h("span", { class: "d-val", "aria-label": `${said} ${label}` }, text));
}

function latamBadge() {
  return h("span", { class: "badge badge--latam", title: "LATAM-validated fare" }, "LATAM");
}

/* ------------------------------------------------------------------ *
 * Sparkline — de-emphasised line, current point in the accent
 * ------------------------------------------------------------------ */

function sparkline(series, { w = 600, hgt = 66 } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("aria-hidden", "true");
  if (series.length < 2) return svg;
  const vals = series.map((p) => p[1]);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = 14;
  const x = (i) => (i / (series.length - 1)) * (w - pad * 2) + pad;
  const y = (v) => hi === lo ? hgt / 2 : hgt - pad - ((v - lo) / (hi - lo)) * (hgt - pad * 2);
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", series.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" "));
  line.setAttribute("class", "spark-line");
  svg.append(line);
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", x(series.length - 1).toFixed(1));
  dot.setAttribute("cy", y(vals.at(-1)).toFixed(1));
  dot.setAttribute("r", "9");
  dot.setAttribute("class", "spark-dot");
  svg.append(dot);
  return svg;
}

/* ------------------------------------------------------------------ *
 * Watched routes — the slot in latest.json, and its movement
 * ------------------------------------------------------------------ */

const routeState = (latest, route) =>
  latest.routes?.[route.id] ?? { label: route.label, role: route.role, current: null, currentTs: null, lastSeen: null };

const routeSeries = (daily, route) =>
  Object.entries(daily.routeDaily?.[route.id] ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));

// latest.json carries no per-route delta, but daily.json's per-route series does:
// compare today's price with the most recent earlier day that recorded this route.
function routeMove(daily, route, price) {
  if (price == null) return null;
  const series = routeSeries(daily, route);
  const prev = series.filter(([d]) => d < (series.at(-1)?.[0] ?? "")).at(-1);
  return prev ? { move: price - prev[1], sinceDay: prev[0] } : null;
}

/* ------------------------------------------------------------------ *
 * Section: hero — the route you want, beside the cheapest on the board
 * ------------------------------------------------------------------ */

function primaryCard(latest, daily) {
  const route = PRIMARY;
  const s = routeState(latest, route);
  const o = s.current;
  const card = h("article", { class: "card rcard rcard--primary" + (o ? " is-live" : "") });

  card.append(h("p", { class: "eyebrow eyebrow--gold" }, "The route you want · ", s.label || route.label));
  card.append(routeStrip(route.path, true));

  if (o) {
    card.append(h("p", { class: "price price--gold" }, aud(o.priceAud2pax)));
    const tags = h("div", { class: "rcard-tags" },
      h("span", { class: "tag" }, (o.carriers?.length ? o.carriers : [o.validating]).filter(Boolean).join(" · ") || "carrier unknown"),
      h("span", { class: "tag" }, o.outStops === 0 ? "non-stop" : `${o.outStops} stops`),
      h("span", { class: "tag" }, fmtDuration(o.outDurationMin), " outbound"));
    if (isLatam(o.validating)) tags.prepend(latamBadge());
    card.append(tags);

    const mv = routeMove(daily, route, o.priceAud2pax);
    if (mv) {
      card.append(h("p", { class: "rcard-move" },
        h("span", { class: mv.move <= 0 ? "d--good" : "d--bad" }, mv.move === 0 ? "no change" : delta(mv.move)),
        ` since ${fmtDay(mv.sinceDay)}`));
    }
    card.append(h("p", { class: "rcard-note" }, "On the board in the search at ", fmtStamp(s.currentTs), "."));
  } else {
    card.append(h("p", { class: "rcard-state" }, "Watching — not currently offered"));
    card.append(h("p", { class: "rcard-note" }, lastSeenNote(s, "No airline has sold this exact path since tracking began.")));
  }
  return card;
}

/** "Last seen 17 Aug, 8:13 pm at A$5,010 for 6 Feb 2027 → 14 Mar 2027." */
function lastSeenNote(s, fallback) {
  const seen = s.lastSeen;
  if (!seen?.offer) return fallback;
  const dates = seen.depDate && seen.retDate ? ` for ${fmtDayYear(seen.depDate)} → ${fmtDayYear(seen.retDate)}` : "";
  return `Last seen ${fmtStamp(seen.ts)} at ${aud(seen.offer.priceAud2pax)}${dates}.`;
}

function cheapestCard(latest) {
  const entry = latest.pinned?.[DEST] ?? null;
  const cheapest = entry?.cheapest ?? null;
  const price = cheapest?.priceAud2pax ?? null;
  const d = latest.deltas?.[DEST] ?? {};
  const low = latest.allTimeLow?.[DEST] ?? null;
  const best = latest.bestInWindow?.[DEST] ?? null;
  const latam = entry?.cheapestLatam ?? null;
  const card = h("article", { class: "card pcard" });

  card.append(h("p", { class: "eyebrow" }, "Cheapest on the pinned dates"));
  card.append(h("div", { class: "pcard-head" },
    h("span", { class: "code" }, DEST),
    h("span", { class: "city" }, CITY[DEST] ?? DEST),
    cheapest && isLatam(cheapest.validating) ? latamBadge() : null));

  if (price == null) {
    card.append(
      h("p", { class: "price price--none" }, "No fare"),
      h("p", { class: "price-note" }, entry
        ? "The last search for these dates came back empty. It runs again at the next fetch."
        : "Not searched yet."));
    return card;
  }

  card.append(
    h("p", { class: "price" }, aud(price)),
    h("p", { class: "price-note" }, `return for two · ${fmtDay(entry.depDate)} → ${fmtDay(entry.retDate)} · ${daysBetween(entry.depDate, entry.retDate)} days`),
    h("ul", { class: "deltas" }, deltaChip("vs yesterday", d.vsYesterdayAud), deltaChip("vs 7 days", d.vs7dAud)));

  if (cheapest.outRoute?.length) {
    card.append(routeStrip(cheapest.outRoute));
    card.append(h("p", { class: "strip-note" },
      `${cheapest.outStops === 0 ? "Non-stop" : cheapest.outStops + (cheapest.outStops === 1 ? " stop" : " stops")} · ${fmtDuration(cheapest.outDurationMin)} outbound · ${(cheapest.carriers?.length ? cheapest.carriers : [cheapest.validating]).filter(Boolean).map((c) => AIRLINE[c] ?? c).join(" · ") || "airline unknown"}`));
  }

  const facts = h("dl", { class: "facts" });
  const fact = (term, val, note) => facts.append(h("div", { class: "fact" },
    h("dt", null, term), h("dd", null, val, note ? h("span", { class: "muted" }, " · " + note) : null)));
  if (low) fact("All-time low", aud(low.priceAud2pax), fmtDay(low.ts.slice(0, 10)));
  if (latam && latam.priceAud2pax !== price) {
    const gap = latam.priceAud2pax - price;
    fact("Cheapest LATAM", aud(latam.priceAud2pax), (gap > 0 ? "+" : "−") + aud(Math.abs(gap)));
  }
  if (best) fact("Best flexible", aud(best.priceAud2pax), `${fmtDay(best.depDate)} → ${fmtDay(best.retDate)}`);
  if (facts.childElementCount) card.append(facts);

  card.append(h("a", { class: "link-out", href: googleFlightsUrl(DEST, entry.depDate, entry.retDate), target: "_blank", rel: "noopener" },
    "Open ", DEST, " on Google Flights", h("span", { "aria-hidden": "true" }, " ↗")));
  return card;
}

function renderHero(latest, daily) {
  const box = $("hero-cards");
  clear(box);
  box.append(primaryCard(latest, daily), cheapestCard(latest));
}

/* ------------------------------------------------------------------ *
 * Section: route watch — the state of every watched path, side by side
 * ------------------------------------------------------------------ */

function watchCard(latest, route) {
  const s = routeState(latest, route);
  const o = s.current;
  const card = h("article", { class: "wcard" + (o ? " is-live" : "") });

  card.append(h("div", { class: "wcard-head" },
    h("span", { class: "wcard-label" }, s.label || route.label),
    h("span", { class: "wcard-role" }, route.role === "primary" ? "primary" : "watch")));
  card.append(routeStrip(route.path));

  if (o) {
    card.append(h("p", { class: "wcard-price" }, aud(o.priceAud2pax)));
    card.append(h("p", { class: "wcard-note" }, "On the board · checked ", fmtStamp(s.currentTs)));
  } else {
    card.append(h("p", { class: "wcard-state" },
      h("span", { class: "wcard-dot", "aria-hidden": "true" }), "Watching — not currently offered"));
    card.append(h("p", { class: "wcard-note" },
      lastSeenNote(s, s.currentTs ? "No sighting on record." : "Not searched yet.")));
  }
  return card;
}

function renderRouteWatch(latest, daily) {
  const box = $("watch-cards");
  clear(box);
  for (const route of WATCHED) box.append(watchCard(latest, route));

  // The primary route's own history, which the pinned-cheapest line cannot show.
  const spark = $("watch-spark");
  clear(spark);
  const series = routeSeries(daily, PRIMARY);
  if (series.length >= 2) {
    const first = series[0], last = series.at(-1);
    const move = last[1] - first[1];
    spark.append(sparkline(series),
      h("p", { class: "spark-note" },
        `${PRIMARY.label} on the pinned dates: ${aud(first[1])} on ${fmtDay(first[0])} → ${aud(last[1])} on ${fmtDay(last[0])}`,
        h("span", { class: "spark-move " + (move <= 0 ? "d--good" : "d--bad") }, " ", move === 0 ? "no change" : delta(move))));
    spark.hidden = false;
  } else {
    spark.hidden = true;
  }
}

/* ------------------------------------------------------------------ *
 * Section: trend — Chart.js line chart + table twin
 * ------------------------------------------------------------------ */

let trendChart = null;

// Three lines, two hues: the cheapest fare in blue (solid on the pinned dates,
// dashed when the dates are flexible) and the primary watched route in amber.
// The pair is validated for CVD separation on both surfaces.
function buildTrendModel(latest, daily) {
  const p = latest.pinned?.[DEST];
  const pinnedSeries = (p && daily.pairs?.[`${DEST}|${p.depDate}|${p.retDate}`]) || {};
  const bestSeries = daily.bestPerDay?.[DEST] || {};
  const routeSeriesMap = daily.routeDaily?.[PRIMARY.id] || {};

  const days = new Set([...Object.keys(pinnedSeries), ...Object.keys(bestSeries), ...Object.keys(routeSeriesMap)]);
  const labels = [...days].sort();
  const at = (series) => labels.map((d) => series[d] ?? null);

  // The primary route leads the legend and is drawn on top: Chart.js paints dataset 0
  // last, and the route often sits exactly on the cheapest line — when they coincide
  // the amber must be the one you see, or the headline series vanishes under the blue.
  const lines = [
    { key: PRIMARY.id, label: `${PRIMARY.label} · pinned dates`, entity: "route", dashed: false, wide: true, data: at(routeSeriesMap) },
    { key: "pinned", label: `${DEST} · pinned dates`, entity: "cheapest", dashed: false, data: at(pinnedSeries) },
    { key: "best", label: `${DEST} · best flexible`, entity: "cheapest", dashed: true, data: at(bestSeries) },
  ];
  return { labels, lines: lines.filter((l) => l.data.some((v) => v != null)), target: latest.alert?.targetAud2pax ?? null };
}

function renderTrendLegend(model) {
  const box = $("trend-legend");
  clear(box);
  for (const line of model.lines) {
    const last = [...line.data].reverse().find((v) => v != null);
    box.append(h("li", { class: "legend-item" },
      h("span", { class: "key" + (line.dashed ? " key--dashed" : ""), style: `--key:${seriesColor(line.entity)}`, "aria-hidden": "true" }),
      h("span", { class: "legend-label" }, line.label),
      h("span", { class: "legend-val" }, aud(last))));
  }
}

function renderTrendTable(model) {
  const box = $("trend-table");
  clear(box);
  const table = h("table", { class: "offers-table" });
  const head = h("tr", null, h("th", { scope: "col" }, "Day"));
  for (const line of model.lines) head.append(h("th", { scope: "col", class: "num" }, line.label));
  table.append(h("thead", null, head));
  const body = h("tbody");
  model.labels.forEach((day, i) => {
    const tr = h("tr", null, h("th", { scope: "row" }, fmtDay(day)));
    for (const line of model.lines) tr.append(h("td", { class: "num" }, aud(line.data[i])));
    body.append(tr);
  });
  table.append(body);
  box.append(table);
}

const crosshairPlugin = {
  id: "southboundCrosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = cssVar("--hair-strong") || "#c3d0d7";
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function targetLinePlugin(target) {
  return {
    id: "southboundTarget",
    afterDatasetsDraw(chart) {
      if (target == null) return;
      const y = chart.scales.y;
      if (target < y.min || target > y.max) return;
      const { ctx, chartArea } = chart;
      const py = y.getPixelForValue(target);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = cssVar("--ink-3") || "#78909d";
      ctx.beginPath();
      ctx.moveTo(chartArea.left, py);
      ctx.lineTo(chartArea.right, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 11px ${cssVar("--font-sans") || "system-ui"}`;
      ctx.fillStyle = cssVar("--ink-2") || "#48606d";
      ctx.textBaseline = "bottom";
      ctx.fillText(`target ${aud(target)}`, chartArea.left + 2, py - 4);
      ctx.restore();
    },
  };
}

function renderTrend(latest, daily) {
  const model = buildTrendModel(latest, daily);
  const empty = $("trend-empty");
  const box = document.querySelector(".chart-box");
  renderTrendLegend(model);
  renderTrendTable(model);

  if (trendChart) { trendChart.destroy(); trendChart = null; }
  if (model.labels.length < 2 || !model.lines.length) {
    empty.textContent = "Not enough history yet — the trend line needs at least two days of searches.";
    empty.hidden = false;
    box.hidden = true;
    return;
  }
  if (typeof Chart === "undefined") {
    empty.textContent = "The chart library did not load. The table below has every value.";
    empty.hidden = false;
    box.hidden = true;
    $("trend-table").hidden = false;
    $("trend-toggle").setAttribute("aria-expanded", "true");
    $("trend-toggle").textContent = "Hide table";
    return;
  }
  empty.hidden = true;
  box.hidden = false;

  const ink3 = cssVar("--ink-3"), hair = cssVar("--hair"), surface = cssVar("--surface");
  const datasets = model.lines.map((line) => {
    const color = seriesColor(line.entity);
    const lastIdx = line.data.reduce((acc, v, i) => (v != null ? i : acc), -1);
    return {
      label: line.label,
      data: line.data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: line.wide ? 2.5 : 2,
      borderDash: line.dashed ? [4, 3] : [],
      tension: 0.15,
      spanGaps: true,
      pointRadius: (ctx) => (ctx.dataIndex === lastIdx ? 4.5 : 0),
      pointHoverRadius: 5.5,
      pointBackgroundColor: color,
      pointBorderColor: surface,
      pointBorderWidth: 2,
    };
  });

  trendChart = new Chart($("trend-canvas"), {
    type: "line",
    data: { labels: model.labels.map(fmtDay), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 8, right: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: cssVar("--tooltip-bg"),
          borderColor: cssVar("--hair-strong"),
          borderWidth: 1,
          titleColor: ink3,
          bodyColor: cssVar("--ink"),
          padding: 10,
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 10,
          boxHeight: 2,
          usePointStyle: false,
          callbacks: { label: (c) => ` ${aud(c.parsed.y)} — ${c.dataset.label}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: hair }, ticks: { color: ink3, maxRotation: 0, autoSkip: true, maxTicksLimit: 6, font: { size: 11 } } },
        y: {
          beginAtZero: false,
          grace: "8%",
          grid: { color: hair, drawTicks: false },
          border: { display: false },
          ticks: { color: ink3, padding: 8, maxTicksLimit: 5, font: { size: 11 }, callback: (v) => audCompact(v) },
        },
      },
    },
    plugins: [crosshairPlugin, targetLinePlugin(model.target)],
  });
}

/* ------------------------------------------------------------------ *
 * Section: heatmap — departure day × trip length
 * ------------------------------------------------------------------ */

const HEAT_BINS = 5;

function heatCells(daily, dest) {
  if (!daily?.pairs) return [];
  const prices = latestPairPrices(daily, dest);
  const cells = [];
  for (const [key, price] of Object.entries(prices)) {
    const [, depDate, retDate] = key.split("|");
    cells.push({ dest, depDate, retDate, price, tripDays: daysBetween(depDate, retDate) });
  }
  return cells;
}

function binOf(price, lo, hi) {
  if (hi <= lo) return Math.floor(HEAT_BINS / 2);
  return Math.min(HEAT_BINS - 1, Math.floor(((price - lo) / (hi - lo)) * HEAT_BINS));
}

function renderHeatDetail(cell, target) {
  const box = $("heat-detail");
  clear(box);
  if (!cell) {
    box.append(h("p", { class: "detail-hint" }, "Pick a cell for the exact dates and a booking link."));
    return;
  }
  box.append(h("p", { class: "detail-head" },
    h("strong", null, aud(cell.price)),
    " · ", CITY[cell.dest] ?? cell.dest, " ",
    target != null && cell.price <= target ? h("span", { class: "badge badge--under" }, "under target") : null));
  box.append(h("p", { class: "detail-body" },
    `${fmtDayYear(cell.depDate)} → ${fmtDayYear(cell.retDate)} · ${cell.tripDays}-day trip`));
  box.append(h("a", { class: "link-out", href: googleFlightsUrl(cell.dest, cell.depDate, cell.retDate), target: "_blank", rel: "noopener" },
    "Open these dates on Google Flights", h("span", { "aria-hidden": "true" }, " ↗")));
}

function renderHeatmap(latest, daily) {
  const grid = $("heat-grid");
  const scale = $("heat-scale");
  const note = $("heat-scale-note");
  clear(grid); clear(scale);
  const target = latest.alert?.targetAud2pax ?? null;
  const cells = heatCells(daily, DEST);

  if (!cells.length) {
    note.textContent = "";
    renderHeatDetail(null, target);
    grid.style.removeProperty("--cols");
    grid.classList.add("is-empty");
    grid.append(h("p", { class: "chart-empty" },
      `No flexible-date searches for ${DEST} yet. The overnight sweep works through the February grid a batch at a time.`));
    return;
  }
  grid.classList.remove("is-empty");

  const deps = [...new Set(cells.map((c) => c.depDate))].sort();
  const lens = [...new Set(cells.map((c) => c.tripDays))].sort((a, b) => a - b);
  const byKey = new Map(cells.map((c) => [c.depDate + "|" + c.tripDays, c]));
  const vals = cells.map((c) => c.price);
  const lo = Math.min(...vals), hi = Math.max(...vals);

  grid.style.setProperty("--cols", String(lens.length));
  grid.append(h("span", { class: "heat-corner" }, h("span", { class: "sr-only" }, "Departure day by trip length")));
  for (const len of lens) grid.append(h("span", { class: "heat-col-label" }, len, h("span", { class: "unit" }, "d")));

  for (const dep of deps) {
    grid.append(h("span", { class: "heat-row-label" }, fmtDay(dep)));
    for (const len of lens) {
      const cell = byKey.get(dep + "|" + len);
      if (!cell) { grid.append(h("span", { class: "heat-cell heat-cell--void", "aria-hidden": "true" }, "·")); continue; }
      const bin = binOf(cell.price, lo, hi);
      const under = target != null && cell.price <= target;
      const btn = h("button", {
        type: "button",
        class: `heat-cell b${bin}` + (under ? " is-under" : ""),
        "aria-label": `${aud(cell.price)}, depart ${fmtDayYear(cell.depDate)}, ${len} day trip${under ? ", under target" : ""}`,
      }, audCompact(cell.price));
      btn.addEventListener("click", () => {
        grid.querySelectorAll(".is-picked").forEach((n) => n.classList.remove("is-picked"));
        btn.classList.add("is-picked");
        renderHeatDetail(cell, target);
      });
      grid.append(btn);
    }
  }

  for (let i = 0; i < HEAT_BINS; i++) scale.append(h("li", { class: "swatch b" + i }));
  note.textContent = `${aud(lo)} cheapest → ${aud(hi)} dearest across ${cells.length} date pairs.` + (target != null ? ` Gold outline marks fares at or under ${aud(target)}.` : "");
  renderHeatDetail(null, target);
}

/* ------------------------------------------------------------------ *
 * Section: offers — latest offers table + filter
 * ------------------------------------------------------------------ */

// "all" | "latam" | a validating carrier code, and a stops bucket.
let offerAirline = "all";
let offerStops = "all";

const STOPS_BUCKETS = [
  ["0-1", "≤1", "One outbound stop or fewer"],
  ["2", "2", "Exactly two outbound stops"],
  ["3+", "3+", "Three or more outbound stops"],
];
const stopsBucket = (n) => (n == null ? null : n <= 1 ? "0-1" : n === 2 ? "2" : "3+");

// Identity of an offer for de-duping: same money, same metal, same routing.
const offerSig = (r) =>
  r.offer ? `${r.offer.priceAud2pax}|${(r.offer.outRoute ?? []).join(">")}|${r.offer.validating ?? ""}|${r.depDate}|${r.retDate}` : "";

function offerRows(latest) {
  const rows = [];
  // Watched routes are quoted against the pinned pair, so they borrow those dates.
  const watched = [];
  for (const route of WATCHED) {
    const offer = routeState(latest, route).current;
    const pinnedPair = latest.pinned?.[route.path.at(-1)];
    if (!offer || !pinnedPair) continue;
    watched.push({
      dest: route.path.at(-1), kind: route.label, route: route.id, primary: route.role === "primary",
      depDate: pinnedPair.depDate, retDate: pinnedPair.retDate,
      price: offer.priceAud2pax, offer, ts: routeState(latest, route).currentTs ?? pinnedPair.ts,
    });
  }
  // The primary route sits above the price sort; the rest join it.
  watched.sort((a, b) => (b.primary === a.primary ? a.price - b.price : b.primary - a.primary));
  const watchedSigs = new Set(watched.map(offerSig));

  for (const [dest, p] of Object.entries(latest.pinned ?? {})) {
    if (p.cheapest) rows.push({ dest, kind: "Pinned dates", depDate: p.depDate, retDate: p.retDate, price: p.cheapest.priceAud2pax, offer: p.cheapest, ts: p.ts });
    if (p.cheapestLatam && p.cheapestLatam.priceAud2pax !== p.cheapest?.priceAud2pax) {
      rows.push({ dest, kind: "Pinned dates · LATAM", depDate: p.depDate, retDate: p.retDate, price: p.cheapestLatam.priceAud2pax, offer: p.cheapestLatam, ts: p.ts });
    }
  }
  for (const [dest, b] of Object.entries(latest.bestInWindow ?? {})) {
    const pinnedPair = latest.pinned?.[dest];
    if (pinnedPair && b.depDate === pinnedPair.depDate && b.retDate === pinnedPair.retDate) continue;
    rows.push({ dest, kind: "Best flexible", depDate: b.depDate, retDate: b.retDate, price: b.priceAud2pax, offer: null, ts: b.ts });
  }
  rows.sort((a, b) => a.price - b.price);
  // The same offer must never appear twice — once as a route, once as the cheapest.
  return [...watched, ...rows.filter((r) => !watchedSigs.has(offerSig(r)))];
}

const offerFiltersActive = () => offerAirline !== "all" || offerStops !== "all";

function offerPasses(r) {
  if (!offerFiltersActive()) return true;
  if (!r.offer) return false; // flexible-date rows carry a price only — no airline, no stops
  if (offerAirline === "latam") { if (!isLatam(r.offer.validating)) return false; }
  else if (offerAirline !== "all" && r.offer.validating !== offerAirline) return false;
  if (offerStops !== "all" && stopsBucket(r.offer.outStops) !== offerStops) return false;
  return true;
}

function routeBadge(row) {
  const path = WATCHED.find((r) => r.id === row.route)?.path.join(" → ") ?? "";
  return h("span", { class: "badge badge--route", title: `${path} — a watched route` }, row.primary ? "Primary" : "Watched");
}

function renderOffers(latest) {
  const body = $("offers-body");
  const note = $("offers-note");
  const hiddenNote = $("offers-hidden-note");
  clear(body);
  const all = offerRows(latest);
  const rows = all.filter(offerPasses);
  const hiddenFlexible = offerFiltersActive() ? all.filter((r) => !r.offer).length : 0;

  if (!rows.length) {
    body.append(h("tr", null, h("td", { colspan: "7", class: "empty-cell" },
      all.length && offerFiltersActive() ? "No offers match this filter." : "No offers in the latest search.")));
  }
  for (const r of rows) {
    const o = r.offer;
    body.append(h("tr", { class: r.primary ? "is-primary" : r.route ? "is-watched" : null },
      h("th", { scope: "row" },
        h("span", { class: "code code--sm" }, r.dest),
        r.route ? routeBadge(r) : null,
        h("span", { class: "row-kind" }, r.kind)),
      h("td", { class: "num strong" }, aud(r.price)),
      h("td", { class: "nowrap" }, `${fmtDay(r.depDate)} → ${fmtDay(r.retDate)}`,
        h("span", { class: "muted block" }, daysBetween(r.depDate, r.retDate), " days")),
      h("td", { class: "airline" },
        o ? (isLatam(o.validating)
          ? h("span", { class: "mono" }, o.validating)
          : (AIRLINE[o.validating] ?? o.validating ?? "—")) : "—",
        o && isLatam(o.validating) ? latamBadge() : null),
      h("td", { class: "num" }, o ? (o.outStops === 0 ? "non-stop" : o.outStops) : "—"),
      h("td", { class: "num" }, o ? fmtDuration(o.outDurationMin) : "—"),
      h("td", null, h("a", { class: "row-link", href: googleFlightsUrl(r.dest, r.depDate, r.retDate), target: "_blank", rel: "noopener", "aria-label": `Open ${r.dest} ${fmtDay(r.depDate)} to ${fmtDay(r.retDate)} on Google Flights` }, "Book ↗"))));
  }
  hiddenNote.hidden = hiddenFlexible === 0;
  hiddenNote.textContent = hiddenFlexible
    ? `${hiddenFlexible} flexible-date ${hiddenFlexible === 1 ? "row" : "rows"} hidden by the filter — those carry a price only, with no airline or stop count to match on.`
    : "";

  const stamps = all.map((r) => r.ts).filter(Boolean).sort();
  const pinnedLine = all.some((r) => r.primary)
    ? `${PRIMARY.label} (${PRIMARY.path.join(" → ")}) is pinned to the top; every other row is cheapest first. `
    : "";
  note.textContent = stamps.length
    ? `${pinnedLine}Flexible rows carry the price only — the full itinerary is re-checked when those dates come round in the sweep. Newest row from ${fmtStamp(stamps.at(-1))}.`
    : "";
}

function renderOfferFilters(latest) {
  const box = $("offer-filters");
  clear(box);
  const rows = offerRows(latest);
  const carriers = [...new Set(rows.map((r) => r.offer?.validating).filter(Boolean))].sort();
  // A carrier can vanish between renders; never leave the table filtered by a ghost.
  if (offerAirline !== "all" && offerAirline !== "latam" && !carriers.includes(offerAirline)) offerAirline = "all";

  const group = (name, label, opts, current, set) => {
    const seg = h("div", { class: "segmented", role: "group", "aria-label": label });
    for (const [val, text, title] of opts) {
      seg.append(h("button", {
        type: "button",
        class: "seg" + (val === current ? " is-on" : ""),
        "aria-pressed": val === current ? "true" : "false",
        title: title ?? null,
        on: {
          click: () => {
            set(val);
            renderOfferFilters(latest);
            renderOffers(latest);
            $("offer-filters").querySelector(`[data-filter="${name}"] .seg.is-on`)?.focus();
          },
        },
      }, text));
    }
    // The visible label repeats the group's accessible name — hide the duplicate.
    return h("div", { class: "filter-group", "data-filter": name },
      h("span", { class: "filter-label", "aria-hidden": "true" }, label), seg);
  };

  box.append(
    group("airline", "Airline",
      [["all", "All"], ["latam", "LATAM", "Any LATAM-validated fare"],
        ...carriers.map((c) => [c, c, AIRLINE[c] ?? c])],
      offerAirline, (v) => { offerAirline = v; }),
    group("stops", "Stops", [["all", "All"], ...STOPS_BUCKETS], offerStops, (v) => { offerStops = v; }));
}

/* ------------------------------------------------------------------ *
 * Section: meta — freshness, budget, target, exports
 * ------------------------------------------------------------------ */

function renderFreshness(latest) {
  const chip = $("freshness");
  const text = chip.querySelector(".freshness-text");
  const { text: rel, hours } = ago(latest.updatedAt);
  const stale = hours > STALE_HOURS;
  const critical = stale && isBrisbaneDaytime();
  chip.classList.toggle("is-stale", stale && !critical);
  chip.classList.toggle("is-critical", critical);
  text.textContent = critical ? `stale — updated ${rel}` : `updated ${rel}`;
  chip.title = latest.updatedAt ? `Last search ${fmtStamp(latest.updatedAt)} Brisbane time` : "No search has run yet";

  $("meta-updated").textContent = fmtStamp(latest.updatedAt);
  $("meta-updated-note").textContent = critical
    ? `${rel}. Twice-daily runs are due morning and evening Brisbane time — check the Actions tab.`
    : `${rel} · sweep cursor at ${latest.sweepCursor ?? 0}`;
}

function renderBudget(latest) {
  const b = latest.budget ?? {};
  const used = b.callsUsed ?? 0, cap = b.cap ?? 0;
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  $("meta-budget").textContent = `${used.toLocaleString("en-AU")} / ${cap.toLocaleString("en-AU")}`;
  const fill = $("meta-gauge-fill");
  fill.style.width = pct.toFixed(1) + "%";
  const level = pct >= 90 ? "critical" : pct >= 75 ? "warning" : "ok";
  $("meta-gauge").dataset.level = level;
  $("meta-gauge").setAttribute("aria-label", `${Math.round(pct)} percent of the monthly API call budget used`);
  $("meta-budget-note").textContent = `${Math.round(pct)}% of the free monthly allowance` + (b.month ? ` · ${b.month}` : "") +
    (level === "critical" ? " — searches will be trimmed." : level === "warning" ? " — nearing the cap." : ".");
}

function renderTarget(latest) {
  const a = latest.alert ?? {};
  const banner = $("alert-banner");
  $("meta-target").textContent = aud(a.targetAud2pax);
  clear(banner);
  if (a.active && a.priceAud2pax != null) {
    banner.hidden = false;
    banner.classList.add("banner--good");
    banner.append(
      h("span", { class: "banner-icon", "aria-hidden": "true" }, "✓"),
      h("span", null, h("strong", null, "Under target — ", aud(a.priceAud2pax), " on the pinned dates."),
        " That is ", aud(a.targetAud2pax - a.priceAud2pax), " below the ", aud(a.targetAud2pax), " line you set."));
    $("meta-target-note").textContent = `Met — best pinned fare is ${aud(a.priceAud2pax)}.`;
  } else {
    banner.hidden = true;
    const best = Object.values(latest.pinned ?? {}).map((p) => p.cheapest?.priceAud2pax).filter((n) => n != null);
    $("meta-target-note").textContent = best.length
      ? `Not met — ${aud(Math.min(...best) - a.targetAud2pax)} to go.`
      : "Waiting on a fare to compare.";
  }
}

const CSV_COLS = ["ts", "origin", "dest", "depDate", "retDate", "tripDays", "status",
  "cheapestAud2pax", "cheapestValidating", "cheapestCarriers", "cheapestOutRoute", "cheapestBackRoute", "cheapestOutStops", "cheapestOutDurationMin",
  "latamAud2pax", "latamValidating",
  ...WATCHED.flatMap((r) => [`${r.id}Aud2pax`, `${r.id}Validating`]),
  "error"];

const csvCell = (v) => {
  const s = v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function historyToCsv(text) {
  const lines = [CSV_COLS.join(",")];
  let rows = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let r;
    try { r = JSON.parse(raw); } catch { continue; }
    rows++;
    const c = r.cheapest ?? {}, l = r.cheapestLatam ?? {};
    // Rows written before the route-watch redesign carry a single `idealRoute` on the
    // via-Sydney path; export it under that route's columns so the CSV stays one table.
    const routes = r.routes ?? { viaSyd: r.idealRoute ?? null };
    lines.push([r.ts, r.origin, r.dest, r.depDate, r.retDate, r.tripDays, r.status,
      c.priceAud2pax, c.validating, c.carriers, c.outRoute, c.backRoute, c.outStops, c.outDurationMin,
      l.priceAud2pax, l.validating,
      ...WATCHED.flatMap((w) => [routes[w.id]?.priceAud2pax, routes[w.id]?.validating]),
      r.error].map(csvCell).join(","));
  }
  return { csv: lines.join("\n") + "\n", rows };
}

async function exportCsv() {
  const btn = $("csv-btn"), status = $("csv-status");
  btn.disabled = true;
  status.textContent = "Building…";
  try {
    const res = await fetch("data/history.jsonl", { cache: "no-store" });
    if (!res.ok) throw new Error(`history.jsonl returned ${res.status}`);
    const { csv, rows } = historyToCsv(await res.text());
    if (!rows) { status.textContent = "No history rows yet."; return; }
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: `southbound-history-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `${rows.toLocaleString("en-AU")} searches exported.`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderMetaLinks(latest) {
  const p = latest.pinned?.[DEST];
  const link = $("meta-gflights");
  if (p) {
    link.href = googleFlightsUrl(DEST, p.depDate, p.retDate);
    link.textContent = `Search ${DEST} on Google Flights ↗`;
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function renderAll(latest, daily) {
  renderFreshness(latest);
  renderTarget(latest);
  renderHero(latest, daily);
  renderRouteWatch(latest, daily);
  renderTrend(latest, daily);
  renderHeatmap(latest, daily);
  renderOfferFilters(latest);
  renderOffers(latest);
  renderBudget(latest);
  renderMetaLinks(latest);

  const p = latest.pinned?.[DEST];
  if (p) {
    // Dates keep their own spaces unbroken, so "6 Feb 2027" never wraps mid-date.
    const nb = (s) => s.replace(/ /g, " ");
    $("trip-line").textContent =
      `Brisbane → ${CITY[DEST]} · 2 travellers · ${nb(fmtDayYear(p.depDate))} → ${nb(fmtDayYear(p.retDate))}`;
  }
}

function showEmptyState(latest) {
  $("empty-state").hidden = false;
  $("dash").hidden = true;
  const t = latest?.alert?.targetAud2pax;
  if (t != null) $("waiting-target").textContent = aud(t);
  const chip = $("freshness");
  chip.classList.add("is-waiting");
  chip.querySelector(".freshness-text").textContent = "no searches yet";
}

function showLoadError(err) {
  const box = $("load-error");
  box.hidden = false;
  clear(box);
  box.append(h("span", { class: "banner-icon", "aria-hidden": "true" }, "!"),
    h("span", null, h("strong", null, "Price data did not load. "),
      "The page needs data/latest.json and data/daily.json alongside it. ", String(err.message ?? err)));
  $("freshness").querySelector(".freshness-text").textContent = "data unavailable";
}

function wireStaticControls() {
  $("csv-btn").addEventListener("click", exportCsv);
  const toggle = $("trend-toggle");
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    toggle.textContent = open ? "Table" : "Hide table";
    $("trend-table").hidden = open;
  });
}

async function main() {
  wireStaticControls();
  let data;
  try {
    data = await loadData();
  } catch (err) {
    showLoadError(err);
    return;
  }
  const { latest, daily } = data;
  if (!latest || latest.updatedAt == null) { showEmptyState(latest); return; }
  $("dash").hidden = false;
  $("empty-state").hidden = true;
  renderAll(latest, daily);

  // Repaint the chart when the OS colour scheme flips — its colours are baked in at draw time.
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener?.("change", () => renderTrend(latest, daily));
  // Keep the "updated N min ago" chip honest without a reload.
  setInterval(() => renderFreshness(latest), 60000);
}

main();
