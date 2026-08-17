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
