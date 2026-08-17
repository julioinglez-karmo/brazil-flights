const ENDPOINT = "https://serpapi.com/search.json";
const BACKOFF_MS = [2000, 8000];
const MAX_ATTEMPTS = 3;

export class SerpApiClient {
  constructor({ apiKey, fetchImpl = fetch, sleepImpl }) {
    if (!apiKey) throw new Error("SERPAPI_API_KEY is required");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Every string that reaches an error message goes through here: the key travels in the
  // query string, so an unredacted URL or echoed response body would publish it to CI logs.
  redact(s) {
    let out = String(s);
    if (this.apiKey) out = out.split(this.apiKey).join("***");
    return out.replace(/api_key=[^&"'\s]+/g, "api_key=***");
  }

  fail(message) {
    return new Error(this.redact(message));
  }

  async searchFlightOffers({ origin, dest, depDate, retDate, adults, currency }) {
    const url = new URL(ENDPOINT);
    url.searchParams.set("engine", "google_flights");
    url.searchParams.set("departure_id", origin);
    url.searchParams.set("arrival_id", dest);
    url.searchParams.set("outbound_date", depDate);
    url.searchParams.set("return_date", retDate);
    url.searchParams.set("type", "1"); // 1 = round trip
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("currency", currency);
    url.searchParams.set("hl", "en");
    url.searchParams.set("gl", "au");
    url.searchParams.set("api_key", this.apiKey);

    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(url);
      if (res.ok) {
        const body = await res.json();
        // SerpAPI signals bad requests with HTTP 200 plus a body-level `error` string.
        if (body?.error) throw this.fail(`SerpAPI error: ${body.error}`);
        return body;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw this.fail(`SerpAPI search failed: ${res.status} ${await res.text()}`);
      }
      await this.sleepImpl(BACKOFF_MS[attempt - 1]);
    }
  }
}
