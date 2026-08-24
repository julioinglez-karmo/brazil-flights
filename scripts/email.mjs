/* ==================================================================
   Southbound — daily email digest
   Renders data/latest.json as an HTML email that reads as the same
   product as the dashboard: cool slate ground, mono airport codes,
   one inverted gold-on-ink panel for the route we actually want.

   Email rules this file obeys, because clients are not browsers:
     · one centred 600px presentation table, no flexbox, no grid
     · every style inline, no <style> block to depend on
     · bgcolor attributes beside every background-color
     · system font stacks only, no webfonts
     · no imagery at all — the ✈ and the route strip are type and cells
     · every colour pair verified at or above 4.5:1
   Missing data never reaches the reader as a placeholder: each value
   degrades to an em dash, or its section adapts.
   ================================================================== */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/* ------------------------------------------------------------------ *
 * Identity — lifted from assets/style.css :root, light surface only.
 * Email clients cannot be trusted with prefers-color-scheme, so the
 * digest commits to the light palette and paints every ground.
 * ------------------------------------------------------------------ */

const C = {
  plane: "#e9eef1",
  surface: "#ffffff",
  surface2: "#f2f6f9",
  ink: "#0c1a22",       // 17.70:1 on surface
  ink2: "#47606d",      //  6.64:1 on surface
  ink3: "#556d7a",      //  5.45:1 on surface, 5.01:1 on surface-2, 4.66:1 on plane
  hair: "#dce4e9",
  hairStrong: "#c3d0d7",
  panel: "#0b2029",
  panelChip: "#293430",  // gold 13% over panel — the dashboard's strip node
  panelLeg: "#726541",   // gold 45% over panel — the hairline between nodes
  gold: "#f0b95e",       //  9.42:1 on panel
  onPanel: "#dfeef4",    // 14.11:1 on panel
  onPanel2: "#8fb1bf",   //  7.35:1 on panel
  goodInk: "#006300",    //  7.54:1 on surface, 6.59:1 on the wash
  badInk: "#b8302f",     //  6.00:1 on surface
  goodWash: "#e4f4e4",
  accent: "#2568d2",     // the cheapest-fare entity, matching --series-1 on the dashboard
};

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";

const CITY = { CWB: "Curitiba", BNE: "Brisbane", MEL: "Melbourne", SYD: "Sydney", SCL: "Santiago" };
const DASHBOARD_URL = "https://julioinglez-karmo.github.io/brazil-flights/";
const EM = "—";

// Brisbane is UTC+10 all year — Queensland has no daylight saving.
const BRISBANE_OFFSET_MS = 10 * 3600000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ------------------------------------------------------------------ *
 * Formatting — mirrors assets/app.js so both surfaces read alike
 * ------------------------------------------------------------------ */

const esc = (v) => String(v)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const isNum = (n) => typeof n === "number" && Number.isFinite(n);

// en-AU integer grouping, without leaning on ICU.
const group = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const aud = (n) => (isNum(n) ? "A$" + group(n) : EM);

/** A Date shifted into Brisbane wall-clock, read back through UTC getters. */
function brisbane(ts) {
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms + BRISBANE_OFFSET_MS) : null;
}

/** "Tuesday 18 August 2026" — the Brisbane day this digest belongs to. */
function longDate(now) {
  const d = brisbane(now);
  if (!d) return EM;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "10 Aug 2026" from an instant, on the Brisbane side of midnight. */
function stampDay(ts) {
  const d = brisbane(ts);
  return d ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : EM;
}

/** "17 Aug 2026, 8:13 pm" — an instant, Brisbane. */
function stamp(ts) {
  const d = brisbane(ts);
  if (!d) return EM;
  const h = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${stampDay(ts)}, ${h % 12 || 12}:${min} ${h < 12 ? "am" : "pm"}`;
}

// Travel dates are plain calendar days — never shift them into a timezone.
const dayOf = (iso) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z")) : null);
const fmtDay = (iso) => { const d = dayOf(iso); return d ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` : EM; };
const fmtDayYear = (iso) => { const d = dayOf(iso); return d ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : EM; };

/** Same query format as googleFlightsUrl() in assets/app.js. */
function googleFlightsUrl(config, dest, depDate, retDate) {
  const q = `Flights from ${config.origin} to ${dest} on ${depDate} through ${retDate} for ${config.adults} passengers`;
  return "https://www.google.com/travel/flights?q=" + encodeURIComponent(q);
}

/* ------------------------------------------------------------------ *
 * Reading the payload — every accessor tolerates a missing branch
 * ------------------------------------------------------------------ */

const pinnedPrice = (latest, dest) => {
  const p = latest?.pinned?.[dest]?.cheapest?.priceAud2pax;
  return isNum(p) ? p : null;
};

function pinnedDates(config, latest, dest) {
  const entry = latest?.pinned?.[dest];
  return {
    depDate: entry?.depDate ?? config?.pinned?.depDate ?? null,
    retDate: entry?.retDate ?? config?.pinned?.retDate ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Watched routes — config owns the paths, latest.json owns the prices
 * ------------------------------------------------------------------ */

const watchedRoutes = (config) => config?.watchedRoutes ?? [];
const primaryRoute = (config) => watchedRoutes(config).find((r) => r.role === "primary") ?? watchedRoutes(config)[0] ?? null;
const secondaryRoutes = (config) => watchedRoutes(config).filter((r) => r !== primaryRoute(config));

/** The route's slot in latest.json, or an empty slot when it has never been written. */
const routeState = (latest, route) =>
  (route && latest?.routes?.[route.id]) || { label: route?.label ?? "", role: route?.role ?? "watch", current: null, currentTs: null, lastSeen: null };

// "via MEL" — the first hub, which is the one that tells the watched routes apart
// (they share SCL) and the one each route's label is named for.
const viaShort = (route) => `via ${route.path[1] ?? route.path.at(-1)}`;

/** The one destination this digest is about. */
const destOf = (config) => primaryRoute(config)?.path.at(-1) ?? config?.destinations?.[0] ?? "CWB";

const priceOf = (offer) => (isNum(offer?.priceAud2pax) ? offer.priceAud2pax : null);

/* ------------------------------------------------------------------ *
 * Subject
 * ------------------------------------------------------------------ */

export function buildSubject({ config, latest }) {
  const dest = destOf(config);
  const route = primaryRoute(config);
  const primary = priceOf(routeState(latest, route).current);
  const best = latest?.bestInWindow?.[dest]?.priceAud2pax;

  // The primary route's own price leads; "cheapest" is the best fare anywhere in the
  // date window, which is the number worth acting on when the route you want is dear.
  const lead = route
    ? `${viaShort(route)} ${primary != null ? aud(primary) : routeState(latest, route).currentTs ? "not offered" : EM}`
    : null;

  const parts = [lead, `cheapest ${isNum(best) ? aud(best) : EM}`].filter(Boolean);
  return `✈ ${config?.origin ?? "BNE"}→${dest} · ${parts.join(" · ")}`;
}

/* ------------------------------------------------------------------ *
 * Markup helpers
 * ------------------------------------------------------------------ */

const TABLE = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';

const p = (style, inner) => `<p style="margin:0;${style}">${inner}</p>`;

const eyebrow = (text, color) =>
  p(`font:700 11.5px/1.4 ${MONO};letter-spacing:.16em;text-transform:uppercase;color:${color};`, esc(text));

/** A full-bleed spacer/rule row: the only way to get a reliable 1px line. */
const rule = (color, height = 1) =>
  `<tr><td height="${height}" bgcolor="${color}" style="background-color:${color};height:${height}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

const gap = (h) => `<tr><td height="${h}" style="height:${h}px;font-size:0;line-height:0;">&nbsp;</td></tr>`;

/** A padded anchor on a solid cell — the bulletproof email button. */
function button(href, label, { bg, fg, border }) {
  const edge = border ? `border:1px solid ${border};` : "";
  return `<table ${TABLE} style="border-collapse:separate;"><tr>` +
    `<td bgcolor="${bg}" align="center" style="background-color:${bg};border-radius:9px;${edge}">` +
    `<a href="${esc(href)}" style="display:inline-block;padding:12px 18px;background-color:${bg};color:${fg};` +
    `font:600 13px/1 ${SANS};text-decoration:none;border-radius:9px;">${esc(label)}</a>` +
    `</td></tr></table>`;
}

/* ------------------------------------------------------------------ *
 * Section: masthead
 * ------------------------------------------------------------------ */

function masthead(config, now) {
  const dest = destOf(config);
  const trip = `${CITY[config?.origin] ?? config?.origin ?? "Brisbane"} → ${CITY[dest] ?? dest} · ${config?.adults ?? 2} travellers`;
  return `<tr><td bgcolor="${C.panel}" style="background-color:${C.panel};padding:26px 26px 22px 26px;border-radius:12px 12px 0 0;">
  ${p(`font:600 13px/1 ${MONO};letter-spacing:.26em;color:${C.onPanel};`,
      `<span style="color:${C.gold};letter-spacing:0;">✈</span>&nbsp;&nbsp;SOUTHBOUND`)}
  ${p(`margin-top:14px;font:400 17px/1.35 ${SANS};color:${C.onPanel};`, esc(trip))}
  ${p(`margin-top:6px;font:400 13px/1.4 ${SANS};color:${C.onPanel2};`, esc(longDate(now)))}
</td></tr>
${rule(C.gold, 3)}`;
}

/* ------------------------------------------------------------------ *
 * Section: the pinned-dates card
 *
 * The cards stack as rows of the outer table rather than sitting in
 * side-by-side cells: rows are the only construction that cannot be
 * squeezed by a narrow client, since mobile Gmail scales a fixed 600px
 * table down instead of reflowing it. Inside each card the figure and
 * its metrics do sit side by side, which is a pairing that survives
 * the scale — a big number next to small labels.
 * ------------------------------------------------------------------ */

function metricRow(label, value, color, weight = 600) {
  return `<tr>
    <td align="left" valign="top" style="padding:5px 10px 5px 0;font:400 12.5px/1.4 ${SANS};color:${C.ink3};white-space:nowrap;">${esc(label)}</td>
    <td align="right" valign="top" style="padding:5px 0;font:${weight} 13.5px/1.4 ${MONO};color:${color};white-space:nowrap;">${value}</td>
  </tr>`;
}

/** "▼ A$120" green, "▲ A$85" red, "No change", or an em dash. */
function moveRow(label, n) {
  if (!isNum(n)) return metricRow(label, EM, C.ink3, 400);
  if (n === 0) return metricRow(label, "No change", C.ink3, 400);
  return metricRow(label, `${n < 0 ? "▼" : "▲"} ${aud(Math.abs(n))}`, n < 0 ? C.goodInk : C.badInk);
}

/** "BNE → MEL → SCL → CWB", the plain-text routing of an offer. */
const routeText = (offer) => (offer?.outRoute?.length ? offer.outRoute.join(" → ") : null);

/** "QF · LA" — who actually flies it, now that the route is not carrier-gated. */
const carrierText = (offer) => {
  const list = offer?.carriers?.length ? offer.carriers : offer?.validating ? [offer.validating] : [];
  return list.length ? list.join(" · ") : null;
};

function pinnedCard(config, latest, dest) {
  const accent = C.accent;
  const price = pinnedPrice(latest, dest);
  const { depDate, retDate } = pinnedDates(config, latest, dest);
  const d = latest?.deltas?.[dest] ?? {};
  const low = latest?.allTimeLow?.[dest] ?? null;
  const offer = latest?.pinned?.[dest]?.cheapest ?? null;

  const window = depDate && retDate
    ? `${config?.adults ?? 2} travellers, return · ${fmtDay(depDate)} → ${fmtDayYear(retDate)}`
    : `${config?.adults ?? 2} travellers, return`;

  // A missing figure says so in words — an em dash at display size reads as a
  // stray rule. The tabular metrics beside it still carry the em-dash convention.
  // When the cheapest fare IS the primary route's, the panel above has already shown
  // the routing and the carriers at display size. Repeating them here would say the
  // same thing three times, so the card names the coincidence and stops.
  const primary = primaryRoute(config);
  const isPrimaryOffer = primary != null && price != null &&
    priceOf(routeState(latest, primary).current) === price &&
    routeText(offer) === primary.path.join(" → ");

  const routing = isPrimaryOffer
    ? p(`margin-top:8px;font:400 12.5px/1.45 ${SANS};color:${C.ink3};`,
        esc(`Nothing beats the ${primary.label} routing on these dates.`))
    : routeText(offer)
      ? p(`margin-top:8px;font:600 12px/1.4 ${MONO};letter-spacing:.06em;color:${C.ink3};`, esc(routeText(offer))) +
        (carrierText(offer) ? p(`margin-top:4px;font:400 12.5px/1.4 ${SANS};color:${C.ink3};`, esc(carrierText(offer))) : "")
      : "";

  // 28px against the panel's 32px: the gold hero stays the loudest figure on the page.
  const figure = price == null
    ? p(`margin-top:10px;font:700 26px/1 ${SANS};letter-spacing:-.02em;color:${C.ink3};`, "No fare") +
      p(`margin-top:10px;font:400 13px/1.45 ${SANS};color:${C.ink3};`, "Nothing came back for these dates in the latest search.")
    : p(`margin-top:10px;font:700 28px/1 ${SANS};letter-spacing:-.022em;color:${C.ink};`, esc(aud(price))) +
      p(`margin-top:10px;font:400 13px/1.45 ${SANS};color:${C.ink2};`, esc(window)) +
      routing;

  const lowRows = low && isNum(low.priceAud2pax)
    ? metricRow("All-time low", esc(aud(low.priceAud2pax)), C.ink) +
      metricRow("", `<span style="font:400 12.5px/1.4 ${SANS};color:${C.ink3};">${esc(stampDay(low.ts))}</span>`, C.ink3, 400)
    : metricRow("All-time low", EM, C.ink3, 400);

  return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;border-collapse:separate;">
    <tr>
      <td width="4" bgcolor="${accent}" style="width:4px;background-color:${accent};font-size:0;line-height:0;border-radius:12px 0 0 12px;">&nbsp;</td>
      <td bgcolor="${C.surface}" style="background-color:${C.surface};border:1px solid ${C.hair};border-left:0;border-radius:0 12px 12px 0;padding:18px 20px;">
        <table ${TABLE} width="100%" style="width:100%;">
          <tr>
            <td width="55%" valign="top" style="width:55%;padding-right:10px;">
              ${eyebrow("Cheapest on the pinned dates", C.ink3)}
              ${p(`margin-top:6px;font:600 12.5px/1.3 ${MONO};letter-spacing:.14em;color:${C.ink};`, esc(dest))}
              ${p(`margin-top:4px;font:400 13.5px/1.3 ${SANS};color:${C.ink3};`, esc(CITY[dest] ?? dest))}
              ${figure}
            </td>
            <td width="45%" valign="top" style="width:45%;">
              <table ${TABLE} width="100%" style="width:100%;">
                ${moveRow("vs yesterday", d.vsYesterdayAud)}
                ${moveRow("vs 7 days", d.vs7dAud)}
                <tr><td colspan="2" height="1" bgcolor="${C.hair}" style="background-color:${C.hair};height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>
                ${lowRows}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Section: the gold primary-route panel — the one inverted panel.
 * The route diagram is built from table cells and a hairline cell, so
 * it renders identically with images blocked. It is the signature.
 * ------------------------------------------------------------------ */

function routeStrip(path) {
  const cells = [];
  path.forEach((code, i) => {
    if (i) {
      cells.push(`<td width="20" valign="middle" style="width:20px;padding:0 4px;">` +
        `<table ${TABLE} width="100%" style="width:100%;"><tr>` +
        `<td height="1" bgcolor="${C.panelLeg}" style="background-color:${C.panelLeg};height:1px;font-size:0;line-height:0;">&nbsp;</td>` +
        `</tr></table></td>`);
    }
    const last = i === path.length - 1;
    const bg = last ? C.gold : C.panelChip;
    const fg = last ? C.panel : C.onPanel;
    cells.push(`<td bgcolor="${bg}" align="center" valign="middle" style="background-color:${bg};border-radius:5px;` +
      `padding:6px 10px;font:600 12.5px/1 ${MONO};letter-spacing:.14em;color:${fg};white-space:nowrap;">${esc(code)}</td>`);
  });
  return `<table ${TABLE} style="border-collapse:separate;"><tr>${cells.join("")}</tr></table>`;
}

/** "Last seen 9 Aug 2026 for 6 Feb → 14 Mar 2027." — or nothing, if never. */
function lastSeenLine(lastSeen) {
  const price = priceOf(lastSeen?.offer);
  if (price == null) return null;
  const dates = lastSeen.depDate && lastSeen.retDate ? ` for ${fmtDay(lastSeen.depDate)} → ${fmtDayYear(lastSeen.retDate)}` : "";
  return `Last seen ${stampDay(lastSeen.ts)}${dates} at ${aud(price)}.`;
}

function primaryPanel(config, latest) {
  const route = primaryRoute(config);
  if (!route) return "";
  const state = routeState(latest, route);
  const via = route.path.slice(1, -1).map((code) => CITY[code] ?? code).join(" and ");
  const price = priceOf(state.current);

  let figure;
  if (price != null) {
    const carriers = carrierText(state.current);
    figure = p(`font:700 32px/1 ${SANS};letter-spacing:-.025em;color:${C.gold};`, esc(aud(price))) +
      (carriers ? p(`margin-top:10px;font:600 12.5px/1.4 ${MONO};letter-spacing:.1em;color:${C.onPanel};`, esc(carriers)) : "") +
      p(`margin-top:8px;font:400 13px/1.45 ${SANS};color:${C.onPanel2};`,
        esc(state.currentTs ? `On the board in the search at ${stamp(state.currentTs)}.` : "On the board in the latest search."));
  } else {
    const seen = lastSeenLine(state.lastSeen);
    figure = p(`font:400 15px/1.4 ${SANS};color:${C.onPanel};`, "Not currently offered — watching") +
      p(`margin-top:8px;font:400 13px/1.45 ${SANS};color:${C.onPanel2};`,
        esc(seen ?? "No airline has sold this exact path since tracking began. The fares above still stand."));
  }

  // Stacked as table rows with cell padding rather than divs with margins:
  // Outlook's Word engine honours td padding and quietly drops div margins.
  return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td bgcolor="${C.panel}" style="background-color:${C.panel};border-radius:12px;padding:22px 20px;">
      <table ${TABLE} width="100%" style="width:100%;">
        <tr><td>${eyebrow(`The route you want · ${state.label || route.label}`, C.gold)}</td></tr>
        <tr><td style="padding-top:14px;">${routeStrip(route.path)}</td></tr>
        <tr><td style="padding-top:14px;">${p(`font:400 13px/1.45 ${SANS};color:${C.onPanel2};`,
            esc(`${CITY[route.path[0]] ?? route.path[0]} → ${CITY[route.path.at(-1)] ?? route.path.at(-1)}, via ${via}.`))}</td></tr>
        <tr><td style="padding-top:16px;">${figure}</td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Section: the other watched routes — one line each, live or dark
 * ------------------------------------------------------------------ */

function watchSection(config, latest) {
  const routes = secondaryRoutes(config);
  if (!routes.length) return "";

  const rows = routes.map((route, i) => {
    const state = routeState(latest, route);
    const price = priceOf(state.current);
    const top = i ? `border-top:1px solid ${C.hair};` : "";
    const note = price != null
      ? `${carrierText(state.current) ?? route.path.join(" → ")}`
      : lastSeenLine(state.lastSeen) ?? "No sighting on record";
    return `<tr>
      <td valign="top" style="${top}padding:11px 10px 11px 0;">
        ${p(`font:600 13.5px/1.35 ${SANS};color:${C.ink};`, esc(state.label || route.label))}
        ${p(`margin-top:3px;font:600 11.5px/1.4 ${MONO};letter-spacing:.08em;color:${C.ink3};`, esc(route.path.join(" → ")))}
      </td>
      <td align="right" valign="top" style="${top}padding:11px 0;">
        ${price != null
          ? p(`font:600 15px/1.35 ${MONO};color:${C.ink};`, esc(aud(price)))
          : p(`font:400 12.5px/1.35 ${SANS};color:${C.ink3};white-space:nowrap;`, "Not currently offered")}
        ${p(`margin-top:3px;font:400 12px/1.4 ${SANS};color:${C.ink3};`, esc(note))}
      </td>
    </tr>`;
  }).join("");

  return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td bgcolor="${C.surface}" style="background-color:${C.surface};border:1px solid ${C.hair};border-radius:12px;padding:18px 20px;">
      ${eyebrow("Also watching", C.ink3)}
      <table ${TABLE} width="100%" style="width:100%;margin-top:8px;">${rows}</table>
    </td></tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Section: cheapest anywhere in the window
 * ------------------------------------------------------------------ */

function windowSection(config, latest) {
  const rows = (config?.destinations ?? []).map((dest, i) => {
    const b = latest?.bestInWindow?.[dest] ?? null;
    const has = b && isNum(b.priceAud2pax);
    const dates = has && b.depDate && b.retDate
      ? `${fmtDay(b.depDate)} → ${fmtDayYear(b.retDate)}${isNum(b.tripDays) ? ` · ${b.tripDays} days` : ""}`
      : "Nothing swept yet";
    const top = i ? `border-top:1px solid ${C.hair};` : "";
    return `<tr>
      <td valign="middle" style="${top}padding:11px 8px 11px 0;font:600 12.5px/1.3 ${MONO};letter-spacing:.13em;color:${C.ink};white-space:nowrap;">${esc(dest)}</td>
      <td align="right" valign="middle" style="${top}padding:11px 8px;font:600 14px/1.3 ${MONO};color:${has ? C.ink : C.ink3};white-space:nowrap;">${esc(has ? aud(b.priceAud2pax) : EM)}</td>
      <td align="right" valign="middle" style="${top}padding:11px 0 11px 8px;font:400 12.5px/1.3 ${SANS};color:${C.ink3};white-space:nowrap;">${esc(dates)}</td>
    </tr>`;
  }).join("");

  return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td bgcolor="${C.surface}" style="background-color:${C.surface};border:1px solid ${C.hair};border-radius:12px;padding:18px 20px;">
      ${eyebrow("Cheapest anywhere in the window", C.ink3)}
      <table ${TABLE} width="100%" style="width:100%;margin-top:8px;">${rows}</table>
    </td></tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Section: the target line, or the banner when it has been met
 * ------------------------------------------------------------------ */

function targetSection(config, latest) {
  const a = latest?.alert ?? {};
  const target = isNum(a.targetAud2pax) ? a.targetAud2pax : (isNum(config?.targetPriceAud2pax) ? config.targetPriceAud2pax : null);

  if (a.active) {
    const price = isNum(a.priceAud2pax) ? a.priceAud2pax : null;
    const line = price != null && target != null
      ? `Under target — ${aud(price)} on the pinned dates. That is ${aud(target - price)} below the ${aud(target)} line you set.`
      : price != null
        ? `Under target — ${aud(price)} on the pinned dates.`
        : "Under target — the pinned fare has crossed the line you set.";
    return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td bgcolor="${C.goodWash}" style="background-color:${C.goodWash};border:1px solid ${C.goodInk};border-radius:12px;padding:16px 20px;">
      ${eyebrow("Price alert", C.goodInk)}
      ${p(`margin-top:6px;font:600 15px/1.45 ${SANS};color:${C.goodInk};`, esc(line))}
    </td></tr>
  </table>
</td></tr>`;
  }

  const prices = (config?.destinations ?? []).map((dest) => pinnedPrice(latest, dest)).filter((n) => n != null);
  let line;
  if (target == null) line = "No alert target is set.";
  else if (!prices.length) line = `Alert target ${aud(target)} — waiting on a fare to compare.`;
  else {
    const gap = Math.min(...prices) - target;
    line = gap <= 0
      ? `Alert target ${aud(target)} — the cheapest pinned fare is already under it.`
      : `Alert target ${aud(target)} — currently ${aud(gap)} away.`;
  }

  return `<tr><td style="padding:0 0 12px 0;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td bgcolor="${C.surface2}" style="background-color:${C.surface2};border:1px solid ${C.hair};border-radius:12px;padding:16px 20px;">
      ${p(`font:400 14px/1.45 ${SANS};color:${C.ink};`, esc(line))}
    </td></tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Section: footer — budget, the three actions, the housekeeping note
 * ------------------------------------------------------------------ */

function footer(config, latest) {
  const dests = config?.destinations ?? [];
  const b = latest?.budget ?? {};
  const budgetLine = isNum(b.callsUsed) && isNum(b.cap)
    ? `${group(b.callsUsed)} of ${group(b.cap)} searches used this month`
    : null;

  const verify = dests.map((dest) => {
    const { depDate, retDate } = pinnedDates(config, latest, dest);
    const href = depDate && retDate ? googleFlightsUrl(config, dest, depDate, retDate) : "https://www.google.com/travel/flights";
    return `<td valign="top" style="padding:0 6px 8px 0;">${button(href, `Verify ${dest} on Google Flights`, { bg: C.surface2, fg: C.ink, border: C.hairStrong })}</td>`;
  }).join("");

  const meta = [
    latest?.updatedAt ? `Last search ${stamp(latest.updatedAt)} Brisbane.` : null,
    budgetLine,
    `All prices are AUD grand totals for ${config?.adults ?? 2} adults, return.`,
  ].filter(Boolean);

  return `<tr><td style="padding:8px 4px 0 4px;">
  <table ${TABLE} width="100%" style="width:100%;">
    <tr><td style="padding-bottom:10px;">${button(DASHBOARD_URL, "Open dashboard", { bg: C.ink, fg: C.surface })}</td></tr>
    <tr><td><table ${TABLE}><tr>${verify}</tr></table></td></tr>
    ${meta.map((m) => `<tr><td style="padding-top:10px;font:400 12.5px/1.5 ${SANS};color:${C.ink3};">${esc(m)}</td></tr>`).join("")}
    <tr><td style="padding-top:14px;border-top:1px solid ${C.hairStrong};font:400 12px/1.5 ${SANS};color:${C.ink3};">
      ${esc("Sent by your Southbound tracker · edit MAIL_TO secret to change recipients")}
    </td></tr>
  </table>
</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * The digest
 * ------------------------------------------------------------------ */

/**
 * Render the daily digest. Pure: no clock, no filesystem, no network.
 * @param {{config: object, latest: object, now: Date|string}} input
 * @returns {{subject: string, html: string}}
 */
export function renderEmail({ config, latest, now }) {
  const cfg = config ?? {};
  const data = latest ?? {};
  const subject = buildSubject({ config: cfg, latest: data });

  // The inbox preview line, straight after the subject.
  const a = data.alert ?? {};
  const preheader = a.active && isNum(a.priceAud2pax)
    ? `Under target at ${aud(a.priceAud2pax)} for two.`
    : `${longDate(now)} · the route you want, the pinned fare and the cheapest dates in the window.`;

  const cards = (cfg.destinations ?? []).map((dest) => pinnedCard(cfg, data, dest)).join("\n");

  const html = `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.plane};color:${C.ink};font-family:${SANS};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${C.plane};">${esc(preheader)}</div>
<table ${TABLE} width="100%" bgcolor="${C.plane}" style="width:100%;background-color:${C.plane};">
  <tr><td align="center" style="padding:24px 12px;">
    <table ${TABLE} width="600" style="width:600px;max-width:600px;">
      ${masthead(cfg, now)}
      ${gap(16)}
      ${primaryPanel(cfg, data)}
      ${cards}
      ${watchSection(cfg, data)}
      ${windowSection(cfg, data)}
      ${targetSection(cfg, data)}
      ${footer(cfg, data)}
    </table>
  </td></tr>
</table>
</body>
</html>
`;

  return { subject, html };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").at(-1));
if (isMain) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      dataDir: { type: "string", default: "data" },
      configPath: { type: "string", default: "config.json" },
    },
  });
  if (!values.out) {
    console.error("usage: node scripts/email.mjs --out <path> [--dataDir data] [--configPath config.json]");
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(values.configPath, "utf8"));
  const latest = JSON.parse(readFileSync(join(values.dataDir, "latest.json"), "utf8"));
  const { subject, html } = renderEmail({ config, latest, now: new Date() });
  writeFileSync(values.out, html);

  // Workflow outputs are line-based; a subject must never break the file.
  const oneLine = subject.replace(/[\r\n]+/g, " ").trim();
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `subject=${oneLine}\n`);
  else console.log(oneLine);
}
