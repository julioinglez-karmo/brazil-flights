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

const MEL = ["BNE", "MEL", "SCL", "CWB"];
const SYD = ["BNE", "SYD", "SCL", "CWB"];

function offer(price, route = MEL) {
  return {
    priceAud2pax: price,
    validating: "QF",
    carriers: ["QF", "LA"],
    outRoute: route,
    backRoute: [],
    outStops: route.length - 2,
    outDurationMin: 2005,
  };
}

// Every field populated: the pinned fare, both deltas, the primary route on the
// board, the via-SYD watch dark, a flexible-window best, an all-time low, target unmet.
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
        cheapest: offer(5687),
        cheapestLatam: null,
      },
    },
    deltas: { CWB: { vsYesterdayAud: -120, vs7dAud: 40 } },
    routes: {
      viaMel: {
        label: "via Melbourne", role: "primary",
        current: offer(5687), currentTs: "2026-08-17T10:13:51.826Z",
        lastSeen: { offer: offer(5687), ts: "2026-08-17T10:13:51.826Z", depDate: "2027-02-06", retDate: "2027-03-14" },
      },
      viaSyd: { label: "via Sydney", role: "watch", current: null, currentTs: "2026-08-17T10:13:51.826Z", lastSeen: null },
    },
    bestInWindow: {
      CWB: { priceAud2pax: 4898, depDate: "2027-02-05", retDate: "2027-03-22", tripDays: 45, ts: "2026-08-16T13:30:00.000Z" },
    },
    allTimeLow: {
      CWB: { priceAud2pax: 4898, ts: "2026-08-10T10:13:00.000Z", depDate: "2027-02-05", retDate: "2027-03-22" },
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
    pinned: {}, deltas: {},
    routes: {
      viaMel: { label: "via Melbourne", role: "primary", current: null, currentTs: null, lastSeen: null },
      viaSyd: { label: "via Sydney", role: "watch", current: null, currentTs: null, lastSeen: null },
    },
    bestInWindow: {}, allTimeLow: {},
    alert: { active: false, priceAud2pax: null, targetAud2pax: 4500 },
  };
}

const NOW = new Date("2026-08-17T10:13:51.826Z");

/* ---------------------------------------------------------------- *
 * Subject line
 * ---------------------------------------------------------------- */

test("subject leads with the primary route, then the cheapest anywhere", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.equal(out.subject, "✈ BNE→CWB · via MEL A$5,687 · cheapest A$4,898");
  assertNoJunk(out, "full");
});

test("subject says so in words when the primary route is not on the board", () => {
  const latest = fullFixture();
  latest.routes.viaMel.current = null;
  const out = renderEmail({ config, latest, now: NOW });
  assert.equal(out.subject, "✈ BNE→CWB · via MEL not offered · cheapest A$4,898");
  assertNoJunk(out, "primary dark");
});

test("subject falls back to em dashes when nothing has been found yet", () => {
  const out = renderEmail({ config, latest: sparseFixture(), now: NOW });
  assert.equal(out.subject, "✈ BNE→CWB · via MEL — · cheapest —");
  assertNoJunk(out, "sparse");
});

test("subject never mentions a destination that is no longer tracked", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.ok(!out.subject.includes("GRU"), out.subject);
  assert.ok(!out.subject.includes("Brazil"), "the tracker is BNE→CWB now, not BNE→Brazil");
});

/* ---------------------------------------------------------------- *
 * Full digest body
 * ---------------------------------------------------------------- */

test("full digest renders every figure and every link", () => {
  const out = renderEmail({ config, latest: fullFixture(), now: NOW });
  const { html } = out;

  // The primary route panel.
  assert.ok(html.includes("via Melbourne"), "primary route label");
  assert.ok(html.includes("A$5,687"), "primary route price");
  for (const node of MEL) assert.ok(html.includes(node), `route node ${node}`);
  assert.ok(html.includes("QF · LA"), "the carriers are shown, since the route is not carrier-gated");

  // Pinned dates and the city.
  assert.ok(html.includes("Curitiba"), "destination city");
  assert.ok(html.includes("6 Feb"), "pinned departure");
  assert.ok(html.includes("14 Mar 2027"), "pinned return");

  // Deltas, directional glyphs included.
  assert.ok(html.includes("▼ A$120"), "down vs yesterday");
  assert.ok(html.includes("▲ A$40"), "up vs 7 days");

  // All-time low with its date.
  assert.ok(html.includes("10 Aug 2026"), "all-time low date");

  // The via-SYD watch line.
  assert.ok(html.includes("via Sydney"), "watch route label");
  assert.ok(html.includes("Not currently offered"), "watch empty state");

  // Cheapest anywhere in the window.
  assert.ok(html.includes("A$4,898"), "best in window");
  assert.ok(html.includes("5 Feb"), "window departure");
  assert.ok(html.includes("22 Mar 2027"), "window return");

  // Target line — the pinned fare is 5,687, so 1,187 to go.
  assert.ok(html.includes("Alert target A$4,500"), "target line");
  assert.ok(html.includes("A$1,187 away"), "distance to target");

  // Budget and the two buttons.
  assert.ok(html.includes("42 of 235 searches used this month"), "budget line");
  assert.ok(html.includes(DASH), "dashboard link");
  assert.ok(html.includes(gf("CWB", "2027-02-06", "2027-03-14")), "CWB Google Flights link");
  assert.ok(html.includes("edit MAIL_TO secret to change recipients"), "footer note");

  assertNoJunk(out, "full body");
});

test("the digest never mentions the dropped destination", () => {
  const { html } = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.ok(!html.includes("GRU"), "no GRU anywhere");
  assert.ok(!html.includes("São Paulo"), "no São Paulo anywhere");
});

test("full digest shows no alert banner while the target is unmet", () => {
  const { html } = renderEmail({ config, latest: fullFixture(), now: NOW });
  assert.ok(!html.includes("Under target"), "banner must stay off until the alert fires");
});

/* ---------------------------------------------------------------- *
 * The watched routes
 * ---------------------------------------------------------------- */

test("a watch route that returns shows its price instead of the empty state", () => {
  const latest = fullFixture();
  latest.routes.viaSyd.current = offer(6100, SYD);
  latest.routes.viaSyd.lastSeen = { offer: offer(6100, SYD), ts: "2026-08-17T10:13:51.826Z", depDate: "2027-02-06", retDate: "2027-03-14" };
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("A$6,100"), "the watch route's price");
  assert.ok(!out.html.includes("Not currently offered"), "the empty state is gone once it returns");
  assertNoJunk(out, "watch live");
});

test("a watch route that has been seen before keeps the sighting on the record", () => {
  const latest = fullFixture();
  latest.routes.viaSyd.lastSeen = {
    offer: offer(6400, SYD), ts: "2026-08-09T10:00:00.000Z", depDate: "2027-02-06", retDate: "2027-03-14",
  };
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("Not currently offered"), "still not on the board");
  assert.ok(out.html.includes("A$6,400"), "last-seen price");
  assert.ok(out.html.includes("9 Aug 2026"), "last-seen date");
  assertNoJunk(out, "watch last seen");
});

test("the primary route falls back to its last sighting when today's search misses", () => {
  const latest = fullFixture();
  latest.routes.viaMel.current = null;
  latest.routes.viaMel.lastSeen = {
    offer: offer(5010), ts: "2026-08-09T10:00:00.000Z", depDate: "2027-02-06", retDate: "2027-03-14",
  };
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("Not currently offered"), "the not-offered headline");
  assert.ok(out.html.includes("A$5,010"), "last-seen price");
  assert.ok(out.html.includes("9 Aug 2026"), "last-seen date");
  assertNoJunk(out, "primary last seen");
});

/* ---------------------------------------------------------------- *
 * Sparse digest body
 * ---------------------------------------------------------------- */

test("sparse digest degrades to em dashes instead of placeholders", () => {
  const out = renderEmail({ config, latest: sparseFixture(), now: NOW });
  const { html } = out;
  assert.ok(html.includes("Curitiba"), "the card still renders");
  assert.ok(html.includes("—"), "missing metrics render as an em dash");
  assert.ok(html.includes("No fare"), "a missing headline price says so in words");
  assert.ok(html.includes("Not currently offered"), "both routes show the watching state");
  assert.ok(html.includes(DASH), "dashboard link survives");
  // The verify button falls back to the pinned dates from config.
  assert.ok(html.includes(gf("CWB", "2027-02-06", "2027-03-14")), "link falls back to config dates");
  assert.ok(html.includes("Alert target A$4,500"), "target line still present");
  assertNoJunk(out, "sparse body");
});

test("a latest.json with no routes key at all still renders", () => {
  const latest = sparseFixture();
  delete latest.routes;
  const out = renderEmail({ config, latest, now: NOW });
  assert.ok(out.html.includes("via Melbourne"), "the route comes from config when the data is silent");
  assertNoJunk(out, "no routes key");
});

/* ---------------------------------------------------------------- *
 * Alert
 * ---------------------------------------------------------------- */

test("alert-active digest leads the target section with a banner", () => {
  const latest = fullFixture();
  latest.alert = { active: true, priceAud2pax: 4410, targetAud2pax: 4500 };
  latest.pinned.CWB.cheapest = offer(4410);
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
  assert.ok(out.subject.startsWith("✈ BNE→CWB"), out.subject);
  assert.ok(!out.html.includes("GRU"), "the regenerated data carries no GRU");
});
