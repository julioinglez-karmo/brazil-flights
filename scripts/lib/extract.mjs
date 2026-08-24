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

const samePath = (a, b) => a.length === b.length && a.every((code, i) => code === b[i]);

/** The all-null slot map: every watched route id, nothing found. */
export function nullRoutes(watchedRoutes) {
  return Object.fromEntries((watchedRoutes ?? []).map((r) => [r.id, null]));
}

export function extractSerpSearch(body, { latamCarriers, watchedRoutes, dest }) {
  const pool = [...(body?.best_flights ?? []), ...(body?.other_flights ?? [])];
  const all = pool.map(serpOfferSummary);
  const latam = pool.filter((o) => isLatamOption(o, latamCarriers)).map(serpOfferSummary);

  // A watched route is matched on the outbound path alone. It is deliberately NOT
  // carrier-gated: the real via-MEL and via-SYD itineraries are Qantas-marketed with
  // LATAM long-haul legs, so requiring an all-LATAM option would blank the card for a
  // route that is genuinely on sale. The carriers are shown on the card instead.
  // `cheapestLatam` keeps the all-LATAM rule; the two answer different questions.
  const routes = {};
  for (const route of watchedRoutes ?? []) {
    routes[route.id] = dest === route.path.at(-1)
      ? cheapestOf(all.filter((s) => samePath(s.outRoute, route.path)))
      : null;
  }

  return { cheapest: cheapestOf(all), cheapestLatam: cheapestOf(latam), routes };
}
