// tests/budget.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBudget, remainingCalls, recordCalls } from "../scripts/lib/budget.mjs";

const now = new Date("2026-09-03T10:00:00Z");

test("normalizeBudget resets on month change", () => {
  const prev = { month: "2026-08", callsUsed: 1900, cap: 1950 };
  assert.deepEqual(normalizeBudget(prev, now, 1950), { month: "2026-09", callsUsed: 0, cap: 1950 });
});

test("normalizeBudget keeps same-month usage and handles null", () => {
  const prev = { month: "2026-09", callsUsed: 120, cap: 1950 };
  assert.deepEqual(normalizeBudget(prev, now, 1950), { month: "2026-09", callsUsed: 120, cap: 1950 });
  assert.deepEqual(normalizeBudget(null, now, 1950), { month: "2026-09", callsUsed: 0, cap: 1950 });
});

test("remainingCalls and recordCalls", () => {
  const b = { month: "2026-09", callsUsed: 1940, cap: 1950 };
  assert.equal(remainingCalls(b), 10);
  assert.equal(remainingCalls(recordCalls(b, 15)), 0);
});
