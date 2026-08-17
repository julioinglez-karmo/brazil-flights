function cheapestOf(summaries) {
  return summaries.length
    ? summaries.reduce((a, b) => (b.priceAud2pax < a.priceAud2pax ? b : a))
    : null;
}

// "QF 545" -> "QF". Google reports the marketing flight number only.
function carrierOf(flight) {
  return String(flight?.flight_number ?? "").trim().split(/\s+/)[0] ?? "";
}

// Google Flights carries no validating-carrier field, so "is this a LATAM itinerary?" is an
// approximation: every segment must be flown under a LATAM flight-number prefix or by an
// airline whose name says LATAM (catches LATAM legs marketed under an unfamiliar prefix).
function isLatamOption(option, latamCarriers) {
  const flights = option?.flights ?? [];
  return (
    flights.length > 0 &&
    flights.every((f) => latamCarriers.includes(carrierOf(f)) || String(f?.airline ?? "").includes("LATAM"))
  );
}

export function serpOfferSummary(option) {
  const flights = option?.flights ?? [];
  const carriers = [];
  for (const f of flights) {
    const c = carrierOf(f);
    if (c && !carriers.includes(c)) carriers.push(c);
  }
  return {
    priceAud2pax: Number(option?.price),
    // `validating` is a marketing-carrier approximation: Google has no validating airline, so we
    // report the first segment's prefix — the honest label for mixed itineraries the dashboard
    // badges via `validating ∈ latamCarriers`.
    validating: flights.length ? carrierOf(flights[0]) : "",
    carriers,
    outRoute: flights.length
      ? [flights[0].departure_airport.id, ...flights.map((f) => f.arrival_airport.id)]
      : [],
    // SerpAPI returns return-leg detail only via a second departure_token call — out of budget.
    backRoute: [],
    outStops: Math.max(0, flights.length - 1),
    outDurationMin: option?.total_duration ?? 0,
  };
}

export function extractSerpSearch(body, { latamCarriers, idealRoutePath, dest }) {
  const pool = [...(body?.best_flights ?? []), ...(body?.other_flights ?? [])];
  const all = pool.map(serpOfferSummary);
  const latam = pool.filter((o) => isLatamOption(o, latamCarriers)).map(serpOfferSummary);
  const ideal =
    dest === idealRoutePath.at(-1)
      ? // Ideal-route options must be all-LATAM; non-LATAM options on the same path count only
        // toward cheapest overall.
        latam.filter((s) => JSON.stringify(s.outRoute) === JSON.stringify(idealRoutePath))
      : [];
  return { cheapest: cheapestOf(all), cheapestLatam: cheapestOf(latam), idealRoute: cheapestOf(ideal) };
}
