import test from "node:test";
import assert from "node:assert/strict";
import { latestCompletedUsTradingSession, isEarlyClose, isUsTradingDay } from "../market-calendar.js";
import { updateSnapshot } from "../scripts/update-market-data.mjs";

const NOW = Date.parse("2026-09-15T22:00:00Z"); // Monday 18:00 New York, after close.
const response = (body) => ({ ok: true, json: async () => body, text: async () => String(body) });
const dayStamp = (day) => Math.floor(Date.parse(`${day}T20:00:00Z`) / 1000);
const neos = (rate = "14.39") => `<div>Distribution Information (as of 08/31/2026) Distribution Rate ${rate}%</div>`;

function fetcher(options = {}) {
  return async (url) => {
    const parsed = new URL(url); const symbol = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (parsed.hostname.includes("alphavantage")) {
      const ticker = parsed.searchParams.get("symbol"); const fn = parsed.searchParams.get("function");
      if (options.alphaFails?.includes(ticker)) throw new Error("network");
      if (fn === "GLOBAL_QUOTE") return response({ "Global Quote": { "05. price": options.alphaPrice?.[ticker] || "100", "07. latest trading day": options.alphaDate?.[ticker] || "2026-09-15" } });
      return response({ data: options.shortHistory?.includes(ticker) ? [{ ex_dividend_date: "2026-08-01", amount: "1" }] : [{ ex_dividend_date: "2026-09-01", amount: "1" }, { ex_dividend_date: "2025-08-01", amount: "1" }] });
    }
    if (parsed.hostname.includes("query1.finance.yahoo.com")) {
      if (options.yahooFails?.includes(symbol)) throw new Error("network");
      if (parsed.searchParams.has("events")) return response({ chart: { result: [{ events: { dividends: { a: { date: dayStamp("2026-09-01"), amount: 1 }, b: { date: dayStamp("2025-08-01"), amount: 1 } } } }] } });
      const day = options.yahooDate?.[symbol] || "2026-09-15"; return response({ chart: { result: [{ timestamp: [dayStamp(day)], indicators: { quote: [{ close: [Number(options.yahooPrice?.[symbol] || 101)] }] } }] } });
    }
    if (parsed.hostname.includes("neosfunds.com")) return { ok: true, text: async () => neos(symbol === "spyi" ? "12.15" : "14.39") };
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

test("FX has a dated secondary source and preserves an explicit stale status when both fail", async () => {
  const secondary = await updateSnapshot({ apiKey: "", now: NOW, fetcher: fetcher({ fxPrimaryFails: true }) });
  assert.deepEqual(secondary.fx, { rate: 7.21, fx_date: "2026-09-15", source: "Open Exchange Rates", fetched_at: new Date(NOW).toISOString() });
  const failed = await updateSnapshot({ previous: secondary, apiKey: "", now: NOW + 3600000, fetcher: fetcher({ fxPrimaryFails: true, fxBackupFails: true }) });
  assert.equal(failed.fx.status, "stale"); assert.equal(failed.fx.fx_date, "2026-09-15");
});

test("NEOS is labelled as official Distribution Rate and new ordinary ETFs never become false 0%", async () => {
  const snapshot = await updateSnapshot({ apiKey: "test", now: NOW, fetcher: fetcher({ shortHistory: ["QNDX"] }) });
  assert.deepEqual(snapshot.symbols.QQQI.dividend_rate, { rate: 0.1439, data_date: "2026-08-31", source: "NEOS official Distribution Rate", kind: "distribution_rate", fetched_at: new Date(NOW).toISOString() });
  assert.equal(snapshot.symbols.SPYI.dividend_rate.rate, 0.1215);
  assert.equal(snapshot.symbols.QNDX.dividend_rate.coverage, "insufficient");
  assert.equal("rate" in snapshot.symbols.QNDX.dividend_rate, false);
  assert.equal(snapshot.symbols.SCHD.dividend_rate.coverage, "complete");
});
