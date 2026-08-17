export function parseDurationMin(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function routeOf(itinerary) {
  const segs = itinerary.segments;
  return [segs[0].departure.iataCode, ...segs.map((s) => s.arrival.iataCode)];
}

export function offerSummary(offer) {
  const [out, back] = offer.itineraries;
  const carriers = [];
  for (const it of offer.itineraries) {
    for (const s of it.segments) {
      if (!carriers.includes(s.carrierCode)) carriers.push(s.carrierCode);
    }
  }
  return {
    priceAud2pax: Number(offer.price.grandTotal),
    validating: offer.validatingAirlineCodes?.[0] ?? "",
    carriers,
    outRoute: routeOf(out),
    backRoute: back ? routeOf(back) : [],
    outStops: out.segments.length - 1,
    outDurationMin: parseDurationMin(out.duration),
  };
}

function cheapestOf(summaries) {
  return summaries.length
    ? summaries.reduce((a, b) => (b.priceAud2pax < a.priceAud2pax ? b : a))
    : null;
}

export function extractSearch(body, { latamCarriers, idealRoutePath, dest }) {
  const all = (body?.data ?? []).map(offerSummary);
  const latam = all.filter((s) => latamCarriers.includes(s.validating));
  const ideal =
    dest === idealRoutePath.at(-1)
      ? all.filter((s) => latamCarriers.includes(s.validating) && JSON.stringify(s.outRoute) === JSON.stringify(idealRoutePath))
      : [];
  return { cheapest: cheapestOf(all), cheapestLatam: cheapestOf(latam), idealRoute: cheapestOf(ideal) };
}
