# Brazil Flights

Tracks round-trip flight prices from Brisbane (BNE) to Curitiba (CWB) for 2 passengers on a single ticket, with departure in February 2027 and return in March 2027.

Alongside the cheapest fare on any routing, the tracker watches two exact paths:

- **via Melbourne** — `BNE → MEL → SCL → CWB`, the primary route, shown as the headline figure.
- **via Sydney** — `BNE → SYD → SCL → CWB`, not currently sold by any airline. The dashboard shows an explicit watching state that lights up, with the last price seen, if it ever returns.

A route matches on its exact outbound path, whoever markets it — the via-MEL itinerary is sold by Qantas with LATAM long-haul legs, so the carriers are reported on the card rather than used as a filter. The separate "cheapest LATAM" figure still requires an all-LATAM itinerary.

Prices are sourced from Google Flights via [SerpAPI](https://serpapi.com/google-flights-api) (free tier: 250 searches/month) and updated automatically by GitHub Actions — the pinned itinerary is checked three times daily (08:00, 14:00 and 20:00 Brisbane) and a flexible-date sweep runs overnight, working through a 32-unit grid four searches at a time, so the whole February grid refreshes about every 8 days. The tracker monitors for deals matching your target price and displays historical trends.

**Dashboard:** https://julioinglez-karmo.github.io/brazil-flights/

Set the `SERPAPI_API_KEY` repository secret to your SerpAPI private API key.

**Daily email digest.** After the nightly sweep commits its data (23:30 Brisbane), the `sweep` workflow emails a summary of the day: the via-Melbourne fare and its carriers, the cheapest fare on the pinned dates with its moves against yesterday and last week, the all-time low, the state of the via-Sydney watch, the cheapest dates anywhere in the window, and how far the target still is. Sending needs three more secrets — `MAIL_USERNAME` and `MAIL_APP_PASSWORD` (a Gmail app password, not your account password) for the sending account, and `MAIL_TO` for the recipients; change who gets it by editing `MAIL_TO`, which takes a comma-separated list. To send the current data to yourself at any time, run the `email` workflow from the Actions tab — it only re-renders what is already committed, so it costs nothing against the SerpAPI budget.

Edit `config.json` to customise search dates, destinations, watched routes and price alerts. A watched route is `{id, label, role, path}`, where `role` is `primary` (the headline) or `watch`; adding one starts tracking it on the next run. Note that `assets/app.js` mirrors the same list, because the dashboard is a static page and does not fetch the config — keep the two in step. All prices shown are in AUD for 2 adults.
