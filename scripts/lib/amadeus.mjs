const BASES = { test: "https://test.api.amadeus.com", production: "https://api.amadeus.com" };
const BACKOFF_MS = [2000, 8000];

export class AmadeusClient {
  constructor({ clientId, clientSecret, env = "test", fetchImpl = fetch, sleepImpl }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    if (!BASES[env]) throw new Error(`unknown AMADEUS_ENV: ${env}`);
    this.base = BASES[env];
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.accessToken = null;
  }

  async token() {
    if (this.accessToken) return this.accessToken;
    const res = await this.fetchImpl(`${this.base}/v1/security/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Amadeus auth failed: ${res.status} ${await res.text()}`);
    this.accessToken = (await res.json()).access_token;
    return this.accessToken;
  }

  async searchFlightOffers({ origin, dest, depDate, retDate, adults, currency, maxOffers }) {
    const url = new URL(`${this.base}/v2/shopping/flight-offers`);
    url.searchParams.set("originLocationCode", origin);
    url.searchParams.set("destinationLocationCode", dest);
    url.searchParams.set("departureDate", depDate);
    url.searchParams.set("returnDate", retDate);
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("currencyCode", currency);
    url.searchParams.set("max", String(maxOffers));

    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${await this.token()}` } });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 3) {
        throw new Error(`Amadeus search failed: ${res.status} ${await res.text()}`);
      }
      await this.sleepImpl(BACKOFF_MS[attempt - 1]);
    }
  }
}
