# Brazil Flights

Tracks round-trip flight prices from Brisbane (BNE) to Curitiba (CWB) and São Paulo (GRU) for 2 passengers, with departure in February 2027 and return in March 2027.

Prices are sourced from Google Flights via [SerpAPI](https://serpapi.com/google-flights-api) (free tier: 250 searches/month) and updated automatically by GitHub Actions — the pinned itinerary is checked twice daily (08:00 and 20:00 Brisbane) and a flexible-date sweep runs once daily. The tracker monitors for deals matching your target price and displays historical trends.

**Dashboard:** https://julioinglez-karmo.github.io/brazil-flights/

Set the `SERPAPI_API_KEY` repository secret to your SerpAPI private API key.

Edit `config.json` to customize search dates, destinations, and price alerts. All prices shown are in AUD for 2 adults.
