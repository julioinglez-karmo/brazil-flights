import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderEmail } from "../scripts/email.mjs";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url)));

const DASH = "https://julioinglez-karmo.github.io/brazil-flights/";
const gf = (dest, dep, ret) =>
  "https://www.google.com/travel/flights?q=" +
  encodeURIComponent(`Flights from BNE to ${dest} on ${dep} through ${ret} for 2 passengers`);

// A rendered digest must never leak a JS placeholder into a person's inbox.
// These three substrings are the tell for every "missing value reached the
// template" bug, so both halves of the payload are swept for all of them.
function assertNoJunk({ subject, html }, where) {
  for (const bad of ["undefined", "null", "NaN"]) {
    assert.ok(!subject.includes(bad), `${where}: subject leaked "${bad}" — ${subject}`);
    assert.ok(!html.includes(bad), `${where}: html leaked "${bad}"`);
  }
}

function offer(price, route) {
  return {
    priceAud2pax: price,
    validating: "LA",
    carriers: ["LA"],
    outRoute: route,
    backRoute: [],
    outStops: route.length - 2,
    outDurationMin: 1905,
  };
}

// Every field populated: two pinned fares, both deltas, the ideal route on the
// board, flexible-window bests, all-time lows, alert not yet met.
function fullFixture() {
  return {
    updatedAt: "2026-08-17T10:13:51.826Z",
    sweepCursor: 8,
    budget: { month: "2026-08", callsUsed: 42, cap: 235 },
    pinned: {
      CWB: {
        ts: "2026-08-17T10:13:51.826Z",
        depDate: "2027-02-06",
        retDate: "2027-03-14",
        cheapest: offer(5644, ["BNE", "MEL", "SCL", "CWB"]),
        cheapestLatam: null,
      },
      GRU: {
        ts: "2026-08-17T10:13:51.826Z",
        depDate: "2027-02-06",
        retDate: "2027-03-14",
        cheapest: offer(5099, ["BNE", "MEL", "SCL", "GRU"]),
        cheapestLatam: null,
      },
    },
    deltas: {
      CWB: { vsYesterdayAud: -120, vs7dAud: 40 },
      GRU: { vsYesterdayAud: 85, vs7dAud: -260 },
    },
    idealRoute: {
      latest: offer(5210, ["BNE", "SYD", "SCL", "CWB"]),
      latestTs: "2026-08-17T10:13:51.826Z",
      lastSeen: null,
    },
    bestInWindow: {
      CWB: { priceAud2pax: 5320, depDate: "2027-02-09", retDate: "2027-03-18", tripDays: 37, ts: "2026-08-16T13:30:00.000Z" },
      GRU: { priceAud2pax: 4980, depDate: "2027-02-01", retDate: "2027-03-03", tripDays: 30, ts: "2026-08-15T13:30:00.000Z" },
    },
    allTimeLow: {
      CWB: { priceAud2pax: 5188, ts: "2026-08-10T10:13:00.000Z", depDate: "2027-02-06", retDate: "2027-03-14" },
      GRU: { priceAud2pax: 4877, ts: "2026-08-12T22:05:00.000Z", depDate: "2027-02-06", retDate: "2027-03-14" },
    },
    alert: { active: false, priceAud2pax: null, targetAud2pax: 4500 },
  };
}

// Day one, or a run where every search errored: the keys exist but hold nothing.
function sparseFixture() {
  return {
    updatedAt: "2026-08-17T10:13:51.826Z",
    sweepCursor: 0,
    budget: { month: "2026-08", callsUsed: 0, cap: 235 },
    pinned: {},
    deltas: {},
    idealRoute: { latest: null, latestTs: null, lastSeen: null },
    bestInWindow: {},
    allTimeLow: {},
    alert: { active: false, priceAud2pax: null, targetAud2pax: 4500 },
  };
}

const NOW = new Date("2026-08-17T10:13:51.826Z");

/* ---------------------------------------------------------------- *
 * Subject line
 * ---------------------------------------------------------------- */

test("subject carries both prices with yesterday's move", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.equal(out.subject, "✈ BNE→Brazil · CWB A$5,644 ▼120 · GRU A$5,099 ▲85");
  assertNoJunk(out, "full");
});

test("subject omits the arrow when there is no yesterday to compare", () => {
  const latest = fullFixture();
  latest.deltas.CWB.vsYesterdayAud = null;
  const out = renderEmail({ config, latest, now: NOW });
  assert.equal(out.subject, "✈ BNE→Brazil · CWB A$5,644 · GRU A$5,099 ▲85");
});

test("subject shows a flat day as a zero drop", () => {
  const latest = fullFixture();
  latest.deltas.CWB.vsYesterdayAud = 0;
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.subject.includes("CWB A$5,644 ▼0"), out.subject);
});

test("subject falls back to an em dash for a missing pinned price", () => {
  const out = renderEmail({ config, latest: sparseFixture(), now: NOW });
  assert.equal(out.subject, "✈ BNE→Brazil · CWB — · GRU —");
  assertNoJunk(out, "sparse");
});

/* ---------------------------------------------------------------- *
 * Full digest body
 * ---------------------------------------------------------------- */

test("full digest renders every figure and every link", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: NOW });
  const { html } = out;

  // Pinned prices and the cities they belong to.
  assert.ok(html.includes("A$5,644"), "CWB pinned price");
  assert.ok(html.includes("A$5,099"), "GRU pinned price");
  assert.ok(html.includes("Curitiba"), "CWB city");
  assert.ok(html.includes("São Paulo"), "GRU city");

  // Deltas, directional glyphs included.
  assert.ok(html.includes("▼ A$120"), "CWB down vs yesterday");
  assert.ok(html.includes("▲ A$40"), "CWB up vs 7 days");
  assert.ok(html.includes("▲ A$85"), "GRU up vs yesterday");
  assert.ok(html.includes("▼ A$260"), "GRU down vs 7 days");

  // All-time lows with their dates.
  assert.ok(html.includes("A$5,188"), "CWB all-time low");
  assert.ok(html.includes("A$4,877"), "GRU all-time low");
  assert.ok(html.includes("10 Aug 2026"), "CWB all-time low date");
  assert.ok(html.includes("13 Aug 2026"), "GRU all-time low date (Brisbane side of 12 Aug 22:05Z)");

  // Ideal route strip.
  assert.ok(html.includes("A$5,210"), "ideal route price");
  for (const node of ["BNE", "SYD", "SCL", "CWB"]) assert.ok(html.includes(node), `ideal node ${node}`);
  assert.ok(!html.includes("Not seen in the latest search"), "ideal strip should not show the empty state");

  // Cheapest anywhere in the window.
  assert.ok(html.includes("A$5,320"), "CWB best in window");
  assert.ok(html.includes("A$4,980"), "GRU best in window");
  assert.ok(html.includes("9 Feb"), "CWB window departure");
  assert.ok(html.includes("18 Mar 2027"), "CWB window return");

  // Target line — cheapest pinned fare is GRU at 5,099, so 599 to go.
  assert.ok(html.includes("Alert target A$4,500"), "target line");
  assert.ok(html.includes("A$599 away"), "distance to target");

  // Budget and the three buttons.
  assert.ok(html.includes("42 of 235 searches used this month"), "budget line");
  assert.ok(html.includes(DASH), "dashboard link");
  assert.ok(html.includes(gf("CWB", "2027-02-06", "2027-03-14")), "CWB Google Flights link");
  assert.ok(html.includes(gf("GRU", "2027-02-06", "2027-03-14")), "GRU Google Flights link");
  assert.ok(html.includes("edit MAIL_TO secret to change recipients"), "footer note");

  assertNoJunk(out, "full body");
});

test("full digest shows no alert banner while the target is unmet", () => {
  const { html } = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.ok(!html.includes("Under target"), "banner must stay off until the alert fires");
});

/* ---------------------------------------------------------------- *
 * Sparse digest body
 * ---------------------------------------------------------------- */

test("sparse digest degrades to em dashes instead of placeholders", () => {
  const out = renderEmail({ config, latest: sparseFixture(), now: NOW });
  const { html } = out;
  assert.ok(html.includes("Curitiba"), "cards still render");
  assert.ok(html.includes("São Paulo"), "cards still render");
  assert.ok(html.includes("—"), "missing metrics render as an em dash");
  assert.ok(html.includes("No fare"), "a missing headline price says so in words");
  assert.ok(html.includes(DASH), "dashboard link survives");
  // The verify buttons fall back to the pinned dates from config.
  assert.ok(html.includes(gf("CWB", "2027-02-06", "2027-03-14")), "CWB link falls back to config dates");
  assert.ok(html.includes(gf("GRU", "2027-02-06", "2027-03-14")), "GRU link falls back to config dates");
  assert.ok(html.includes("Alert target A$4,500"), "target line still present");
  assertNoJunk(out, "sparse body");
});

test("sparse digest shows the ideal route's not-seen state", () => {
  const { html } = renderEmail({ config, latest: sparseFixture(), now: NOW });
  assert.ok(html.includes("Not seen in the latest search"), "ideal empty state");
});

test("ideal route falls back to the last sighting when today's search misses", () => {
  const latest = sparseFixture();
  latest.idealRoute = {
    latest: null,
    latestTs: "2026-08-17T10:13:51.826Z",
    lastSeen: {
      ts: "2026-08-09T10:00:00.000Z",
      depDate: "2027-02-06",
      retDate: "2027-03-14",
      offer: offer(5010, ["BNE", "SYD", "SCL", "CWB"]),
    },
  };
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("Not seen in the latest search"), "still the not-seen headline");
  assert.ok(out.html.includes("A$5,010"), "last-seen price");
  assert.ok(out.html.includes("9 Aug 2026"), "last-seen date");
  assertNoJunk(out, "ideal last seen");
});

/* ---------------------------------------------------------------- *
 * Alert
 * ---------------------------------------------------------------- */

test("alert-active digest leads the target section with a banner", () => {
  const latest = fullFixture();
  latest.alert = { active: true, priceAud2pax: 4410, targetAud2pax: 4500 };
  latest.pinned.GRU.cheapest = offer(4410, ["BNE", "MEL", "SCL", "GRU"]);
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("Under target"), "banner headline");
  assert.ok(out.html.includes("A$4,410"), "banner price");
  assert.ok(out.html.includes("A$90"), "how far below the line");
  assertNoJunk(out, "alert");
});

test("alert banner survives a missing alert price", () => {
  const latest = fullFixture();
  latest.alert = { active: true, priceAud2pax: null, targetAud2pax: 4500 };
  const out = renderEmail({ config, latest, now: NOW });
  assertNoJunk(out, "alert without price");
});

/* ---------------------------------------------------------------- *
 * Brisbane date in the masthead
 * ---------------------------------------------------------------- */

test("masthead date is the Brisbane day, not the UTC day", () => {
  // 20:00 UTC is 06:00 the next morning in Brisbane (UTC+10, no DST).
  const out = renderEmail({ config, latest: fullFixture(), now: new Date("2026-08-17T20:00:00Z") });
  const expected = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(new Date("2026-08-17T20:00:00Z")).replace(",", "");
  assert.equal(expected, "Tuesday 18 August 2026", "sanity-check the expectation against ICU");
  assert.ok(out.html.includes("Tuesday 18 August 2026"), "masthead shows the Brisbane date");
  assert.ok(!out.html.includes("Monday 17 August 2026"), "and not the UTC date");
});

test("masthead date holds the same day before the Brisbane rollover", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: new Date("2026-08-17T10:13:51.826Z") });
  assert.ok(out.html.includes("Monday 17 August 2026"), "20:13 Brisbane is still the 17th");
});

/* ---------------------------------------------------------------- *
 * Email-client safety
 * ---------------------------------------------------------------- */

test("markup is balanced and free of layout CSS email clients drop", () => {
  const { html } = renderEmail({ config, latest: fullFixture(), now: NOW });
  for (const tag of ["table", "tr", "td", "a"]) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, "g"))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
    assert.equal(open, close, `unbalanced <${tag}>`);
  }
  assert.ok(!/<style[\s>]/.test(html), "no <style> block to depend on");
  assert.ok(!/display\s*:\s*(flex|grid)/.test(html), "no flexbox or grid");
  assert.ok(!/<img[\s>]/.test(html), "no imagery to be blocked");
  assert.ok(html.includes('role="presentation"'), "layout tables are presentational");
  assert.ok(html.includes('charset="utf-8"'), "declares utf-8 for the accents and glyphs");
});

test("renders the same html twice for the same input", () => {
  const a = renderEmail({ config, latest: fullFixture(), now: NOW });
  const b = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.equal(a.html, b.html);
  assert.equal(a.subject, b.subject);
});

test("renders against the repository's real latest.json", () => {
  const latest = JSON.parse(readFileSync(new URL("../data/latest.json", import.meta.url)));
  const out = renderEmail({ config, latest, now: NOW });
  assertNoJunk(out, "real data");
  assert.ok(out.subject.startsWith("✈ BNE→Brazil"), out.subject);
});
