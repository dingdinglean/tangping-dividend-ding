import test from "node:test";
import assert from "node:assert/strict";
import { latestCompletedUsTradingSession, isEarlyClose, isUsTradingDay } from "../market-calendar.js";
import { updateSnapshot } from "../scripts/update-market-data.mjs";

const NOW = Date.parse("2026-09-15T22:00:00Z"); // Monday 18:00 New York, after close.
const response = (body) => ({ ok: true, json: async () => body, text: async () => String(body) });
const dayStamp = (day) => Math.floor(Date.parse(`${day}T20:00:00Z`) / 1000);
const neos = (rate = "14.39") => `<div>Distribution Information (as of 08/31/2026) Distribution Rate ${rate}%</div>`;
const stateStreet = ({ fundDistributionYield, noYield } = {}) => `<div>Yields as of Sep 15 2026 ${fundDistributionYield ? `Fund Distribution Yield ${fundDistributionYield}%` : noYield ? "Index Dividend Yield 0.58%" : "30 Day SEC Yield 0.44%"}</div>`;

function fetcher(options = {}) {
  return async (url) => {
    const parsed = new URL(url); const symbol = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (parsed.hostname.includes("alphavantage")) {
      const ticker = parsed.searchParams.get("symbol"); const fn = parsed.searchParams.get("function");
      if (options.alphaFails?.includes(ticker)) throw new Error("network");
      if (fn === "GLOBAL_QUOTE") return response({ "Global Quote": { "05. price": options.alphaPrice?.[ticker] || "100", "07. latest trading day": options.alphaDate?.[ticker] || "2026-09-15" } });
      return response({ data: options.shortHistory?.includes(ticker) ? [{ ex_dividend_date: "2026-08-01", amount: "1" }] : [{ ex_dividend_date: "2026-09-01", amount: "1" }, { ex_dividend_date: "2025-09-15", amount: "1" }] });
    }
    if (parsed.hostname.includes("query1.finance.yahoo.com")) {
      if (options.yahooFails?.includes(symbol)) throw new Error("network");
      if (parsed.searchParams.has("events")) return response({ chart: { result: [{ events: { dividends: { a: { date: dayStamp("2026-09-01"), amount: 1 }, b: { date: dayStamp("2025-09-15"), amount: 1 } } } }] } });
      const day = options.yahooDate?.[symbol] || "2026-09-15"; return response({ chart: { result: [{ timestamp: [dayStamp(day)], indicators: { quote: [{ close: [Number(options.yahooPrice?.[symbol] || 101)] }] } }] } });
    }
    if (parsed.hostname.includes("api.nasdaq.com") && parsed.pathname.endsWith("/historical")) {
      const ticker = parsed.pathname.split("/").filter(Boolean).at(-2);
      if (options.nasdaqHistoricalFails?.includes(ticker)) throw new Error("network");
      if (options.assertNasdaqHistoricalRange && ticker === "QNDX") {
        assert.equal(parsed.searchParams.get("fromdate"), "2026-09-11");
        assert.equal(parsed.searchParams.get("todate"), "2026-09-21");
        assert.equal(parsed.searchParams.get("limit"), "20");
      }
      return response({ data: { tradesTable: { rows: options.nasdaqHistorical?.[ticker] || null } } });
    }
    if (parsed.hostname.includes("api.nasdaq.com") && parsed.pathname.endsWith("/dividends")) {
      const ticker = parsed.pathname.split("/").filter(Boolean).at(-2);
      if (options.nasdaqDividendFails?.includes(ticker)) throw new Error("network");
      return response({ data: { dividends: { rows: options.nasdaqDividends?.[ticker] || null } } });
    }
    if (parsed.hostname.includes("neosfunds.com")) return { ok: true, text: async () => neos(symbol === "spyi" ? "12.15" : "14.39") };
    if (parsed.hostname.includes("ssga.com")) { if (options.stateStreetFails) throw new Error("network"); return { ok: true, text: async () => stateStreet({ fundDistributionYield: options.stateStreetFundYield, noYield: options.stateStreetNoYield }) }; }
    if (parsed.hostname.includes("frankfurter")) { if (options.fxPrimaryFails) throw new Error("network"); return response({ rate: 7.2, date: "2026-09-15" }); }
    if (parsed.hostname.includes("open.er-api.com")) { if (options.fxBackupFails) throw new Error("network"); return response({ rates: { CNY: 7.21 }, time_last_update_unix: dayStamp("2026-09-15") }); }
    throw new Error(`unexpected ${url}`);
  };
}

test("NYSE calendar uses New York close, weekends, holidays and early closes", () => {
  assert.deepEqual(latestCompletedUsTradingSession(Date.parse("2026-09-15T22:00:00Z")).date, "2026-09-15");
  // Monday morning Beijing is Sunday in New York, so Friday is the last session.
  assert.equal(latestCompletedUsTradingSession(Date.parse("2026-09-14T00:00:00Z")).date, "2026-09-11");
  assert.equal(isUsTradingDay("2026-09-07"), false); // Labor Day
  assert.equal(latestCompletedUsTradingSession(Date.parse("2026-09-08T14:00:00Z")).date, "2026-09-04");
  assert.equal(isEarlyClose("2026-11-27"), true);
  assert.equal(latestCompletedUsTradingSession(Date.parse("2026-11-27T17:30:00Z")).date, "2026-11-25"); // 12:30 ET, not closed yet
  assert.equal(latestCompletedUsTradingSession(Date.parse("2026-11-27T18:10:00Z")).date, "2026-11-27"); // 13:10 ET, complete
});

test("stale primary quote automatically falls back only when backup has the completed session", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ alphaDate: { QQQI: "2026-09-14" }, yahooPrice: { QQQI: 102.5 } }) });
  const price = snapshot.symbols.QQQI.price;
  assert.deepEqual({ symbol: price.symbol, price: price.price, price_date: price.price_date, source: price.source, fetched_at: price.fetched_at }, { symbol: "QQQI", price: 102.5, price_date: "2026-09-15", source: "Yahoo Finance Chart", fetched_at: new Date(NOW).toISOString() });
  assert.equal(snapshot.symbols.QQQI.price_status, "valid");
});

test("primary rate limit and a single-symbol data failure do not poison other ETFs or disguise stale data", async () => {
  const priorDates = { QQQI: "2026-09-14", SPYI: "2026-09-14", QNDX: "2026-09-14", SCHD: "2026-09-14" };
  const first = await updateSnapshot({ apiKey: "test", now: Date.parse("2026-09-14T22:00:00Z"), fetcher: fetcher({ alphaDate: priorDates, yahooDate: priorDates }) });
  const snapshot = await updateSnapshot({ previous: first, apiKey: "test", now: NOW, fetcher: fetcher({ alphaFails: ["SPYI"], yahooFails: ["SPYI"] }) });
  assert.equal(snapshot.symbols.QQQI.price_status, "valid");
  assert.equal(snapshot.symbols.SPYI.price_status, "stale");
  assert.equal(snapshot.symbols.SPYI.price.price_date, "2026-09-14");
  assert.equal(snapshot.symbols.SPYI.expected_price_date, "2026-09-15");
  assert.equal(snapshot.symbols.SPYI.price_error, "upstream_unavailable");
});

test("a failed retry retains a same-session close as valid instead of falsely marking it stale", async () => {
  const previous = { schemaVersion: 2, symbols: { QQQI: { price: { symbol: "QQQI", price: 100, price_date: "2026-09-15", source: "Nasdaq official close", fetched_at: "2026-09-15T22:00:00.000Z" } } } };
  const snapshot = await updateSnapshot({ previous, apiKey: "test", now: NOW, fetcher: fetcher({ alphaFails: ["QQQI"], yahooFails: ["QQQI"] }) });
  assert.equal(snapshot.symbols.QQQI.price_status, "valid");
  assert.equal(snapshot.symbols.QQQI.price.price_date, "2026-09-15");
  assert.equal(snapshot.symbols.QQQI.price_error, undefined);
});

test("Nasdaq historical close supplies the exact completed session when Alpha Vantage is stale", async () => {
  const now = Date.parse("2026-09-21T22:00:00Z");
  const snapshot = await updateSnapshot({ apiKey: "test", now, fetcher: fetcher({
    assertNasdaqHistoricalRange: true,
    alphaDate: { QNDX: "2026-09-18" },
    nasdaqHistorical: { QNDX: [
      { date: "09/18/2026", close: "$24.44" },
      { date: "09/21/2026", close: "$24.52" },
    ] },
  }) });
  const row = snapshot.symbols.QNDX;
  assert.equal(row.price.price, 24.52);
  assert.equal(row.price.price_date, "2026-09-21");
  assert.equal(row.price.source, "Nasdaq historical close");
  assert.equal(row.price_status, "valid");
  assert.equal(row.expected_price_date, "2026-09-21");
  assert.equal(row.price_error, undefined);
});

test("all price sources returning an older session retain the old price and mark it stale", async () => {
  const now = Date.parse("2026-09-21T22:00:00Z");
  const previous = { schemaVersion: 2, symbols: { QNDX: { price: { symbol: "QNDX", price: 24.44, price_date: "2026-09-18", source: "Yahoo Finance Chart", fetched_at: "2026-09-19T01:00:00.000Z" } } } };
  const snapshot = await updateSnapshot({ previous, apiKey: "test", now, fetcher: fetcher({
    alphaDate: { QNDX: "2026-09-18" },
    yahooDate: { QNDX: "2026-09-18" },
    nasdaqHistorical: { QNDX: [{ date: "09/18/2026", close: "$24.44" }] },
  }) });
  const row = snapshot.symbols.QNDX;
  assert.equal(row.price.price, 24.44);
  assert.equal(row.price.price_date, "2026-09-18");
  assert.equal(row.price_status, "stale");
  assert.equal(row.expected_price_date, "2026-09-21");
  assert.equal(row.price_error, "price_date_stale");
});

test("a verified current-session price remains valid when every remote price source fails", async () => {
  const now = Date.parse("2026-09-21T22:00:00Z");
  const previous = { schemaVersion: 2, symbols: { QNDX: { price: { symbol: "QNDX", price: 24.52, price_date: "2026-09-21", source: "Nasdaq historical close", fetched_at: "2026-09-21T22:00:00.000Z" } } } };
  const snapshot = await updateSnapshot({ previous, apiKey: "test", now, fetcher: fetcher({
    nasdaqHistoricalFails: ["QNDX"], alphaFails: ["QNDX"], yahooFails: ["QNDX"],
  }) });
  const row = snapshot.symbols.QNDX;
  assert.equal(row.price.price, 24.52);
  assert.equal(row.price.price_date, "2026-09-21");
  assert.equal(row.price_status, "valid");
  assert.equal(row.expected_price_date, "2026-09-21");
  assert.equal(row.price_error, undefined);
});

test("FX has a dated secondary source and preserves an explicit stale status when both fail", async () => {
  const secondary = await updateSnapshot({ apiKey: "", now: NOW, fetcher: fetcher({ fxPrimaryFails: true }) });
  assert.deepEqual(secondary.fx, { rate: 7.21, fx_date: "2026-09-15", source: "Open Exchange Rates", fetched_at: new Date(NOW).toISOString() });
  const failed = await updateSnapshot({ previous: secondary, apiKey: "", now: NOW + 3600000, fetcher: fetcher({ fxPrimaryFails: true, fxBackupFails: true }) });
  assert.equal(failed.fx.status, "stale"); assert.equal(failed.fx.fx_date, "2026-09-15");
});

test("NEOS remains an official Distribution Rate while QNDX uses a separately typed official yield", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ shortHistory: ["QNDX"] }) });
  assert.deepEqual(snapshot.symbols.QQQI.dividend_rate, { rate: 0.1439, data_date: "2026-08-31", source: "NEOS official Distribution Rate", kind: "distribution_rate", fetched_at: new Date(NOW).toISOString() });
  assert.equal(snapshot.symbols.SPYI.dividend_rate.rate, 0.1215);
  assert.deepEqual(snapshot.symbols.QNDX.dividend_rate, { rate: 0.0044, data_date: "2026-09-15", source: "State Street official 30 Day SEC Yield", kind: "30_day_sec_yield", yield_type: "30 Day SEC Yield", coverage: "complete", fetched_at: new Date(NOW).toISOString(), status: "valid" });
  assert.equal(snapshot.symbols.SCHD.dividend_rate.coverage, "complete");
  assert.equal(snapshot.symbols.SCHD.dividend_rate.kind, "ttm_distribution_yield");
});

test("QNDX prefers State Street Fund Distribution Yield when the fund publishes one", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ shortHistory: ["QNDX"], stateStreetFundYield: "1.23" }) });
  assert.deepEqual(snapshot.symbols.QNDX.dividend_rate, { rate: 0.0123, data_date: "2026-09-15", source: "State Street official Fund Distribution Yield", kind: "fund_distribution_yield", yield_type: "Fund Distribution Yield", coverage: "complete", fetched_at: new Date(NOW).toISOString(), status: "valid" });
});

test("QNDX falls back to a verified TTM Distribution Yield when State Street has no direct yield", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ stateStreetNoYield: true }) });
  const rate = snapshot.symbols.QNDX.dividend_rate;
  assert.equal(rate.rate, 0.02);
  assert.equal(rate.kind, "ttm_distribution_yield");
  assert.equal(rate.yield_type, "TTM Distribution Yield");
  assert.equal(rate.data_date, "2026-09-01");
  assert.equal(rate.status, "valid");
});

test("QNDX uses Nasdaq official distributions before the existing Alpha Vantage/Yahoo fallback", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ stateStreetNoYield: true, nasdaqDividends: { QNDX: [{ exOrEffDate: "09/01/2026", paymentDate: "09/10/2026", amount: "$1.50" }, { exOrEffDate: "09/15/2025", paymentDate: "09/25/2025", amount: "$0.50" }] } }) });
  const rate = snapshot.symbols.QNDX.dividend_rate;
  assert.equal(rate.rate, 0.02);
  assert.equal(rate.source, "Nasdaq official dividends");
  assert.equal(rate.yield_type, "TTM Distribution Yield");
  assert.equal(rate.data_date, "2026-09-01");
});

test("QNDX uses the ordinary ETF TTM fallback when State Street is unavailable", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ stateStreetFails: true }) });
  assert.equal(snapshot.symbols.QNDX.dividend_rate.kind, "ttm_distribution_yield");
  assert.equal(snapshot.symbols.QNDX.dividend_rate.rate, 0.02);
  assert.equal(snapshot.symbols.QNDX.dividend_rate.status, "valid");
});

test("QNDX retains the last valid yield and marks it stale when every source fails", async () => {
  const previous = { schemaVersion: 2, symbols: { QNDX: { dividend_rate: { rate: 0.0044, data_date: "2026-09-15", source: "State Street official 30 Day SEC Yield", kind: "30_day_sec_yield", yield_type: "30 Day SEC Yield", coverage: "complete", fetched_at: "2026-09-15T22:00:00.000Z", status: "valid" } } } };
  const snapshot = await updateSnapshot({ previous, apiKey: "test", now: NOW + 3600000, fetcher: fetcher({ alphaFails: ["QNDX"], yahooFails: ["QNDX"], stateStreetFails: true }) });
  assert.equal(snapshot.symbols.QNDX.dividend_rate.rate, 0.0044);
  assert.equal(snapshot.symbols.QNDX.dividend_rate.data_date, "2026-09-15");
  assert.equal(snapshot.symbols.QNDX.dividend_rate.yield_type, "30 Day SEC Yield");
  assert.equal(snapshot.symbols.QNDX.dividend_rate.status, "stale");
});
