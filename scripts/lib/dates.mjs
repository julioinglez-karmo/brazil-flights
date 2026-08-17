export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function sweepGrid(config) {
  const { depDates, tripLengths, minTripDays, latestReturn } = config.sweep;
  const units = [];
  for (const dest of config.destinations) {
    for (let day = depDates.firstDay; day <= depDates.lastDay; day += depDates.step) {
      const depDate = `${depDates.month}-${String(day).padStart(2, "0")}`;
      for (const tripDays of tripLengths) {
        const retDate = addDays(depDate, tripDays);
        if (tripDays >= minTripDays && retDate <= latestReturn) {
          units.push({ dest, depDate, retDate, tripDays });
        }
      }
    }
  }
  return units;
}

export function nextSweepBatch(grid, cursor, batchSize) {
  const start = cursor % grid.length;
  const units = [];
  for (let i = 0; i < Math.min(batchSize, grid.length); i++) {
    units.push(grid[(start + i) % grid.length]);
  }
  return { units, nextCursor: (start + units.length) % grid.length };
}
