# Brazil Flights

Tracks round-trip flight prices from Brisbane (BNE) to Curitiba (CWB) and São Paulo (GRU) for 2 passengers, with departure in February 2027 and return in March 2027.

Prices are sourced from Google Flights via [SerpAPI](https://serpapi.com/google-flights-api) (free tier: 250 searches/month) and updated automatically by GitHub Actions — the pinned itinerary is checked twice daily (08:00 and 20:00 Brisbane) and a flexible-date sweep runs once daily. The tracker monitors for deals matching your target price and displays historical trends.

**Dashboard:** https://julioinglez-karmo.github.io/brazil-flights/

Set the `SERPAPI_API_KEY` repository secret to your SerpAPI private API key.

**Daily email digest.** After the nightly sweep commits its data (23:30 Brisbane), the `sweep` workflow emails a summary of the day: both pinned fares with their moves against yesterday and last week, the all-time lows, the ideal LATAM route, the cheapest dates anywhere in the window, and how far the target still is. Sending needs three more secrets — `MAIL_USERNAME` and `MAIL_APP_PASSWORD` (a Gmail app password, not your account password) for the sending account, and `MAIL_TO` for the recipients; change who gets it by editing `MAIL_TO`, which takes a comma-separated list. To send the current data to yourself at any time, run the `email` workflow from the Actions tab — it only re-renders what is already committed, so it costs nothing against the SerpAPI budget.

Edit `config.json` to customize search dates, destinations, and price alerts. All prices shown are in AUD for 2 adults.
