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
  // Feb 2027 has 28 days, so a Feb-D departure returns on day-of-year 31+D+L and the
  // ≤2027-03-31 (day 90) rule reduces to L ≤ 59 − D. Departures are 1,3,…,27:
  //   days 1–13  (7 deps) × {30,37,45} = 21
  //   days 15–21 (4 deps) × {30,37}    =  8
  //   days 23–27 (3 deps) × {30}       =  3
  assert.equal(grid.length, 32);
  for (const u of grid) {
    assert.equal(u.dest, "CWB", "GRU is no longer tracked");
    assert.ok(u.tripDays >= 30);
    assert.ok(u.retDate <= "2027-03-31");
    assert.ok(u.retDate >= "2027-03-01");
    assert.equal(daysBetween(u.depDate, u.retDate), u.tripDays);
  }
  const lengthsFor = (day) => grid.filter((u) => u.depDate === `2027-02-${day}`).map((u) => u.tripDays);
  assert.deepEqual(lengthsFor("01"), [30, 37, 45]);
  assert.deepEqual(lengthsFor("13"), [30, 37, 45], "Feb 13 + 45 returns 2027-03-30, the last day all three fit");
  assert.deepEqual(lengthsFor("15"), [30, 37], "Feb 15 + 45 returns 2027-04-01");
  assert.deepEqual(lengthsFor("21"), [30, 37], "Feb 21 + 45 returns 2027-04-07");
  assert.deepEqual(lengthsFor("23"), [30], "Feb 23 + 37 returns 2027-04-01");
  assert.deepEqual(lengthsFor("27"), [30], "Feb 27 + 30 returns 2027-03-29, the last unit in the grid");
  assert.equal(grid.filter((u) => u.tripDays === 30).length, 14, "every departure fits the 30-day trip");
});

test("nextSweepBatch wraps around", () => {
  const grid = sweepGrid(config);
  const b1 = nextSweepBatch(grid, 30, 8);
  assert.equal(b1.units.length, 8);
  assert.equal(b1.nextCursor, 6); // (30 + 8) % 32
  assert.deepEqual(b1.units[2], grid[0]); // wrapped at index 32
});
