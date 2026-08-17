export function normalizeBudget(prev, now, cap) {
  const month = now.toISOString().slice(0, 7);
  const callsUsed = prev && prev.month === month ? prev.callsUsed : 0;
  return { month, callsUsed, cap };
}

export function remainingCalls(budget) {
  return Math.max(0, budget.cap - budget.callsUsed);
}

export function recordCalls(budget, n) {
  return { ...budget, callsUsed: budget.callsUsed + n };
}
