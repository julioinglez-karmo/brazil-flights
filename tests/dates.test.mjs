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
  // 17 valid date combos x 2 destinations
  assert.equal(grid.length, 34);
  for (const u of grid) {
    assert.ok(u.tripDays >= 30);
    assert.ok(u.retDate <= "2027-03-31");
    assert.ok(u.retDate >= "2027-03-01");
    assert.equal(daysBetween(u.depDate, u.retDate), u.tripDays);
  }
  // Departures Feb 1/5/9/13 fit all three lengths; the ≤2027-03-31 return rule trims the tail.
  const lengthsFor = (day) =>
    grid.filter((u) => u.depDate === `2027-02-${day}` && u.dest === "CWB").map((u) => u.tripDays);
  assert.deepEqual(lengthsFor("01"), [30, 37, 45]);
  assert.deepEqual(lengthsFor("05"), [30, 37, 45]);
  assert.deepEqual(lengthsFor("09"), [30, 37, 45]);
  assert.deepEqual(lengthsFor("13"), [30, 37, 45]);
  assert.deepEqual(lengthsFor("17"), [30, 37], "Feb 17 + 45 returns 2027-04-03");
  assert.deepEqual(lengthsFor("21"), [30, 37], "Feb 21 + 45 returns 2027-04-07");
  assert.deepEqual(lengthsFor("25"), [30], "Feb 25 + 37 returns 2027-04-03");
});

test("nextSweepBatch wraps around", () => {
  const grid = sweepGrid(config);
  const b1 = nextSweepBatch(grid, 30, 8);
  assert.equal(b1.units.length, 8);
  assert.equal(b1.nextCursor, 4); // (30 + 8) % 34
  assert.deepEqual(b1.units[4], grid[0]); // wrapped at index 34
});
