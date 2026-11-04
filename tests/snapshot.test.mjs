import test from "node:test";
import assert from "node:assert/strict";
import { latestCompletedUsTradingSession, isEarlyClose, isUsTradingDay, watchPlan, cashCloseUtc, beijingMorningDeadline } from "../market-calendar.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSnapshot, fetchYahooPrice, fetchNeosDividends, fetchNeosDistributionRate, fetchNeosPrice, snapshotIsPublishable, run, runWatch } from "../scripts/update-market-data.mjs";

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
    if (parsed.hostname.includes("api.nasdaq.com") && parsed.pathname.endsWith("/info")) {
      const ticker = parsed.pathname.split("/").filter(Boolean).at(-2);
      if (options.nasdaqInfoFails?.includes(ticker)) throw new Error("network");
      const info = options.nasdaqInfo?.[ticker];
      if (!info) throw new Error("invalid_data");
      return response({ data: { secondaryData: info } });
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
    if (parsed.hostname.includes("neosfunds.com")) { if (options.neosFails) throw new Error("network"); return { ok: true, text: async () => neos(symbol === "spyi" ? "12.15" : "14.39") }; }
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
  assert.equal(isEarlyClose("2026-07-02"), false);
  assert.equal(isUsTradingDay("2026-07-03"), false);
  assert.equal(isEarlyClose("2026-07-03"), false);
  assert.equal(isEarlyClose("2026-12-24"), true);
  assert.equal(isEarlyClose("2027-07-02"), false);
  assert.equal(isEarlyClose("2027-12-23"), true);
  assert.equal(isEarlyClose("2027-12-24"), false);
  assert.equal(isEarlyClose("2028-07-03"), true);
  assert.equal(isUsTradingDay("2022-07-04"), false);
  assert.equal(isEarlyClose("2022-07-01"), true);
  assert.equal(isEarlyClose("2022-07-03"), false);
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

test("NEOS failure keeps the last distribution rate and marks it stale", async () => {
  const previous = { schemaVersion: 2, symbols: { QQQI: { dividend_rate: { rate: 0.1428, data_date: "2026-09-30", source: "NEOS official Distribution Rate", kind: "distribution_rate", fetched_at: "2026-09-30T00:00:00.000Z" } } } };
  const snapshot = await updateSnapshot({ previous, apiKey: "test", now: NOW, fetcher: fetcher({ neosFails: true }) });
  assert.equal(snapshot.symbols.QQQI.dividend_rate.rate, 0.1428);
  assert.equal(snapshot.symbols.QQQI.dividend_rate.data_date, "2026-09-30");
  assert.equal(snapshot.symbols.QQQI.dividend_rate.kind, "distribution_rate");
  assert.equal(snapshot.symbols.QQQI.dividend_rate.status, "stale");
  assert.equal(snapshot.symbols.SPYI.dividend_rate.coverage, "insufficient");
  assert.equal(snapshot.symbols.SPYI.dividend_rate.status, "unavailable");
});


test("delayed publication retries only unresolved ETFs, with bounded delays and sanitized diagnostics", async () => {
  const base = fetcher({ alphaFails:["SPYI"], yahooFails:["SPYI"] });
  const calls = new Map(); const delays = []; const logs = [];
  const snapshot = await updateSnapshot({ now: NOW, apiKey: "SECRET-ONLY-TEST", priceAttempts: 3, retryDelays: [45000,90000], waiter: async ms => delays.push(ms), logger: entry => logs.push(entry), fetcher: async (url, opts) => {
    const match = /quote\/(\w+)\/historical/.exec(String(url));
    if (match) {
      const ticker = match[1]; calls.set(ticker, (calls.get(ticker)||0)+1);
      if (ticker === "SPYI" && calls.get(ticker) < 3) throw new Error("https://bad.test/?apikey=SECRET-ONLY-TEST");
      return response({ data: { tradesTable: { rows: [{date:"09/15/2026",close:"$100"}] } } });
    }
    return base(url, opts);
  } });
  assert.deepEqual(Object.fromEntries(calls), {QQQI:1,SPYI:3,QNDX:1,SCHD:1,XQQI:1});
  assert.deepEqual(delays, [45000,90000]);
  assert.equal(snapshot.refresh.summary.status, "complete");
  assert.equal(snapshot.refresh.summary.valid, 5);
  assert.equal(JSON.stringify(logs).includes("SECRET-ONLY-TEST"), false);
  assert.equal(JSON.stringify(snapshot).includes("SECRET-ONLY-TEST"), false);
});

test("partial failure has an explicit summary and never rewrites the last valid price date", async () => {
  const previous = { symbols:{ SPYI:{price:{symbol:"SPYI",price:55,price_date:"2026-09-14",source:"test",fetched_at:"2026-09-14T22:00:00Z"}}}};
  const snapshot = await updateSnapshot({previous, now:NOW, apiKey:"test", fetcher:fetcher({alphaFails:["SPYI"],yahooFails:["SPYI"]})});
  assert.deepEqual(snapshot.refresh.summary, {status:"partial",valid:4,total:5,stale_symbols:["SPYI"],updated:4,failed_symbols:["SPYI"]});
  assert.equal(snapshot.symbols.SPYI.price.price_date,"2026-09-14");
  assert.equal(snapshot.symbols.SPYI.price.price,55);
});

test("Alpha Vantage rate limits stop further paid calls and the daily budget persists across runs", async () => {
  const base=fetcher(); let alphaCalls=0;
  const limited=async (url, opts)=>{
    if(String(url).includes("alphavantage")){alphaCalls++;return new Response(JSON.stringify({Information:"API rate limit reached with key SECRET"}));}
    return base(url,opts);
  };
  const snapshot=await updateSnapshot({now:NOW,apiKey:"SECRET",fetcher:limited,priceAttempts:3,waiter:async()=>{}});
  assert.equal(alphaCalls,1);
  assert.equal(snapshot.refresh.alpha_vantage_usage.count,1);
  alphaCalls=0;
  snapshot.refresh.alpha_vantage_usage.count=25;
  const next=await updateSnapshot({previous:snapshot,now:NOW+1000,apiKey:"SECRET",fetcher:limited});
  assert.equal(alphaCalls,0);
  assert.equal(next.refresh.alpha_vantage_usage.count,25);
  assert.equal(next.refresh.summary.valid,5); // Yahoo remains independent.
});

test("Yahoo daily rows select the completed session and cannot promote a live intraday row", async () => {
  const fetchedAt="2026-09-16T16:00:00Z";
  const price=await fetchYahooPrice("QQQI", async()=>response({chart:{result:[{timestamp:[dayStamp("2026-09-15"),dayStamp("2026-09-16")],indicators:{quote:[{close:[100,999]}]}}]}}),fetchedAt);
  assert.equal(price.price_date,"2026-09-15");
  assert.equal(price.price,100);
});


test("US daylight saving transitions validate the exchange close rather than a fixed UTC hour", () => {
  for (const [instant, expected] of [
    ["2026-03-09T19:59:00Z","2026-03-06"], ["2026-03-09T20:00:00Z","2026-03-09"],
    ["2026-11-02T20:59:00Z","2026-10-30"], ["2026-11-02T21:00:00Z","2026-11-02"],
    ["2026-11-26T23:00:00Z","2026-11-25"],
  ]) assert.equal(latestCompletedUsTradingSession(Date.parse(instant)).date,expected);
});

test("a delayed ordinary ETF close recalculates TTM with the accepted final close", async () => {
  const base=fetcher({alphaFails:["SCHD"],yahooFails:["SCHD"],nasdaqDividends:{SCHD:[{exOrEffDate:"09/01/2026",amount:"$1"},{exOrEffDate:"09/15/2025",amount:"$1"}]}}); let attempt=0;
  const previous={symbols:{SCHD:{price:{symbol:"SCHD",price:50,price_date:"2026-09-14",source:"test",fetched_at:"2026-09-14T22:00:00Z"}}}};
  const snapshot=await updateSnapshot({previous,now:NOW,apiKey:"test",priceAttempts:2,waiter:async()=>{},fetcher:async(url,opts)=>{
    if(String(url).includes("quote/SCHD/historical")) {
      if(++attempt===1) throw new Error("network");
      return response({data:{tradesTable:{rows:[{date:"09/15/2026",close:"$100"}]}}});
    }
    return base(url,opts);
  }});
  assert.equal(snapshot.symbols.SCHD.dividend_rate.rate,.02);
  assert.equal(snapshot.symbols.SCHD.price.price,100);
});


test("retaining same-session prices cannot disguise a failed fetch as a successful refresh", async () => {
  const previous={symbols:Object.fromEntries(["QQQI","SPYI","QNDX","SCHD","XQQI"].map(symbol=>[symbol,{price:{symbol,price:100,price_date:"2026-09-15",source:"test",fetched_at:"2026-09-15T21:00:00Z"}}]))};
  const snapshot=await updateSnapshot({previous,now:NOW,fetcher:async()=>{throw new Error("offline");}});
  assert.equal(snapshot.refresh.summary.status,"partial");
  assert.equal(snapshot.refresh.summary.updated,0);
  assert.equal(snapshot.refresh.summary.valid,5);
  assert.equal(snapshot.refresh.summary.failed_symbols.length,5);
  for(const row of Object.values(snapshot.symbols)) {
    assert.equal(row.price_status,"valid");
    assert.equal(row.price.fetched_at,"2026-09-15T21:00:00.000Z");
  }
});


const xqqiHistory = `<table><tr><th>Declaration Date</th><th>Ex-Div Date</th><th>Record Date</th><th>Payable Date</th><th>Amount ($)</th></tr><tr><td>10/06/2026</td><td>10/07/2026</td><td>10/07/2026</td><td>10/09/2026</td><td>$0.8823</td></tr><tr><td>11/03/2026</td><td>11/04/2026</td><td>11/04/2026</td><td>11/06/2026</td><td></td></tr></table>`;
test("XQQI official history reads real dates and amounts and ignores empty future calendar rows", async () => {
  const f = async () => ({ok:true,text:async()=>neos("21.04")+xqqiHistory});
  const history = await fetchNeosDividends("XQQI", f, new Date(NOW).toISOString());
  assert.deepEqual(history.data,[{ex_date:"2026-10-07",payment_date:"2026-10-09",amount:.8823,declaration_date:"2026-10-06",record_date:"2026-10-07"}]);
  assert.equal((await fetchNeosDistributionRate("XQQI", f, new Date(NOW).toISOString())).rate,.2104);
  await assert.rejects(fetchNeosDistributionRate("XQQI", async()=>({ok:true,text:async()=>"Annualized Distribution Target 19-23%"}),new Date(NOW).toISOString()));
});
test("XQQI failed sources preserve old price, official dividends, rate and their original timestamps", async () => {
  const base=fetcher();
  const first=await updateSnapshot({now:NOW,apiKey:"test",fetcher:async(url,opts)=>String(url).includes("neosfunds.com/xqqi")?{ok:true,text:async()=>neos("21.04")+xqqiHistory}:base(url,opts)});
  const old=first.symbols.XQQI;
  const failed=await updateSnapshot({previous:first,now:NOW+86400000,fetcher:async()=>{throw new Error("offline");}});
  const row=failed.symbols.XQQI;
  assert.deepEqual(row.price,old.price); assert.equal(row.price_status,"stale");
  assert.deepEqual(row.dividends.data,old.dividends.data); assert.equal(row.dividends.fetched_at,old.dividends.fetched_at); assert.equal(row.dividends.status,"stale");
  assert.equal(row.dividend_rate.rate,old.dividend_rate.rate); assert.equal(row.dividend_rate.fetched_at,old.dividend_rate.fetched_at); assert.equal(row.dividend_rate.status,"stale");
});

test("official stale XQQI close retains its true date and cannot count as a successful current fetch", async () => {
  const page="Annualized Distribution Target 19-23% Pricing Information Data as of 10/20/2026 Closing NAV Price Net Asset Value $47.89 Daily Change ($) $-0.11 Daily Change (%) -0.23% Closing Market Price Spacer column Market Price $47.87 Daily Change ($) $-0.14 Daily Change (%) -0.28%";
  const f=async url=>{if(String(url).includes("neosfunds.com/xqqi"))return {ok:true,text:async()=>page};throw new Error("offline");};
  const price=await fetchNeosPrice("XQQI",f,"2026-10-22T00:00:00.000Z");
  assert.equal(price.price,47.87); assert.notEqual(price.price,47.89); assert.equal(price.price_date,"2026-10-20");
  assert.equal(price.change,-0.14); assert.equal(price.change_percent,-0.0028);
  const snapshot=await updateSnapshot({now:Date.parse("2026-10-22T00:00:00Z"),fetcher:f});
  assert.deepEqual(snapshot.symbols.XQQI.price,price); assert.equal(snapshot.symbols.XQQI.price_status,"stale");
  assert.equal(snapshot.refresh.summary.updated,0);
  assert.equal(snapshotIsPublishable(snapshot),false);
});

test("XQQI quote refresh keeps the Nasdaq close, session change and price history", async () => {
  const now = Date.parse("2026-10-22T01:48:00Z");
  const snapshot = await updateSnapshot({ now, apiKey: "test", fetcher: fetcher({
    nasdaqHistorical: { XQQI: [{ date: "10/21/2026", close: "$48.57" }, { date: "10/20/2026", close: "$47.87" }, { date: "10/22/2026", close: "$99.99" }] },
    alphaFails: ["XQQI"], yahooFails: ["XQQI"],
  }) });
  const row = snapshot.symbols.XQQI;
  assert.equal(row.price.price, 48.57);
  assert.equal(row.price.price_date, "2026-10-21");
  assert.equal(row.price.source, "Nasdaq historical close");
  assert.equal(row.price.change, 0.7);
  assert.equal(row.price_status, "valid");
  assert.deepEqual(row.price_history.map(item => item.date), ["2026-10-21", "2026-10-20"]);
});

test("an incomplete refresh does not replace the last snapshot file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xqqi-"));
  const output = join(dir, "market.json");
  const original = "{\"schemaVersion\":2,\"keep\":true}\n";
  await writeFile(output, original);
  const snapshot = await run({ output, now: NOW, priceAttempts: 1, waiter: async () => {}, fetcher: async () => { throw new Error("offline"); } });
  assert.equal(snapshotIsPublishable(snapshot), false);
  assert.equal(snapshot.refresh.freshness, "stale");
  assert.equal(await readFile(output, "utf8"), original);
});

test("Nasdaq timeouts are retried before Alpha Vantage is called", async () => {
  let nasdaq = 0;
  let alphaQuotes = 0;
  const base = fetcher({ nasdaqHistorical: { QQQI: [{ date: "09/15/2026", close: "$100" }] } });
  const snapshot = await updateSnapshot({ now: NOW, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: async (url, opts) => {
    const text = String(url);
    if (text.includes("alphavantage") && text.includes("function=GLOBAL_QUOTE") && text.includes("symbol=QQQI")) alphaQuotes++;
    if (text.includes("/QQQI/historical")) {
      nasdaq++;
      if (nasdaq < 3) { const error = new Error("timed out"); error.name = "TimeoutError"; throw error; }
    }
    return base(url, opts);
  } });
  assert.equal(nasdaq, 3);
  assert.equal(alphaQuotes, 0);
  assert.equal(snapshot.symbols.QQQI.price.source, "Nasdaq historical close");
  assert.equal(snapshot.symbols.QQQI.price.price_date, "2026-09-15");
  assert.equal(snapshot.refresh.freshness, "current");
});

test("an unresolved ETF gets a fourth price round", async () => {
  const delays = [];
  let calls = 0;
  const base = fetcher({ alphaFails: ["SPYI"], yahooFails: ["SPYI"] });
  const snapshot = await updateSnapshot({ now: NOW, apiKey: "test", priceAttempts: 4, retryDelays: [10, 20, 30], waiter: async (ms) => delays.push(ms), fetcher: async (url, opts) => {
    if (String(url).includes("/SPYI/historical")) {
      calls++;
      if (calls < 4) throw new Error("not ready");
      return response({ data: { tradesTable: { rows: [{ date: "09/15/2026", close: "$100" }] } } });
    }
    return base(url, opts);
  } });
  assert.equal(calls, 4);
  assert.deepEqual(delays, [10, 20, 30]);
  assert.equal(snapshot.symbols.SPYI.price.price, 100);
  assert.equal(snapshot.refresh.freshness, "current");
});

const withXqqiHistory = (options) => {
  const base = fetcher(options);
  return async (url, opts) => String(url).includes("neosfunds.com/xqqi") ? { ok: true, text: async () => neos("21.04") + xqqiHistory } : base(url, opts);
};

test("a missed session keeps last good quotes, marks them stale, and does not rewrite an unchanged stale file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-"));
  const output = join(dir, "market.json");
  const live = withXqqiHistory();
  const first = await run({ output, now: NOW, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: live });
  assert.equal(snapshotIsPublishable(first), true);
  assert.equal(first.refresh.freshness, "current");
  const before = JSON.parse(await readFile(output, "utf8"));
  const older = Object.fromEntries(["QQQI", "SPYI", "QNDX", "SCHD", "XQQI"].map((symbol) => [symbol, "2026-09-15"]));
  const lagged = withXqqiHistory({
    alphaDate: older,
    yahooDate: older,
    nasdaqHistorical: Object.fromEntries(["QQQI", "SPYI", "QNDX", "SCHD", "XQQI"].map((symbol) => [symbol, [{ date: "09/15/2026", close: "$100" }]])),
  });
  const next = Date.parse("2026-09-16T22:00:00Z");
  const stale = await run({ output, now: next, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: lagged });
  assert.equal(snapshotIsPublishable(stale), false);
  assert.equal(stale.refresh.freshness, "stale");
  assert.equal(stale.refresh.target_price_date, "2026-09-16");
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.refresh.freshness, "stale");
  assert.equal(written.symbols.QQQI.price_status, "stale");
  assert.equal(written.symbols.QQQI.price_error, "price_date_stale");
  assert.equal(written.symbols.QQQI.price.price_date, "2026-09-15");
  assert.equal(written.symbols.QQQI.price.price, before.symbols.QQQI.price.price);
  assert.equal(written.symbols.QQQI.price.fetched_at, before.symbols.QQQI.price.fetched_at);
  assert.ok(written.symbols.QQQI.dividends.data.length > 0);
  assert.equal(written.symbols.SCHD.price_status, "stale");
  assert.equal(written.symbols.XQQI.price_status, "stale");
  const marked = await readFile(output, "utf8");
  const again = await run({ output, now: next + 60000, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: lagged });
  assert.equal(again.refresh.freshness, "stale");
  assert.equal(await readFile(output, "utf8"), marked);
});

test("a thinner Yahoo dividend feed does not replace a verified history for the same ex date", async () => {
  const previous = { schemaVersion: 2, symbols: { SCHD: { dividends: { data: [
    { ex_date: "2026-09-23", payment_date: "2026-09-28", amount: 0.2665, declaration_date: "2026-02-18", record_date: "2026-09-23" },
    { ex_date: "2026-06-24", payment_date: "2026-06-29", amount: 0.25, declaration_date: "2026-02-18", record_date: "2026-06-24" },
    ...Array.from({ length: 10 }, (_, index) => ({ ex_date: `2025-${String(12 - index).padStart(2, "0")}-24`, payment_date: `2025-${String(12 - index).padStart(2, "0")}-28`, amount: 0.2 })),
  ], source: "Alpha Vantage Dividends", fetched_at: "2026-09-15T21:00:00.000Z", status: "valid" } } } };
  const snapshot = await updateSnapshot({ previous, now: NOW, apiKey: "", priceAttempts: 1, waiter: async () => {}, fetcher: fetcher({ nasdaqDividendFails: ["SCHD"] }) });
  const row = snapshot.symbols.SCHD.dividends;
  assert.equal(row.source, "Alpha Vantage Dividends");
  assert.equal(row.data.length, 12);
  assert.equal(row.data[0].payment_date, "2026-09-28");
  assert.equal(row.data[0].amount, 0.2665);
  assert.equal(row.status, "stale");
  assert.equal(row.fetched_at, "2026-09-15T21:00:00.000Z");
});

test("a later run does not rewrite a snapshot whose market fields are unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fresh-"));
  const output = join(dir, "market.json");
  const live = withXqqiHistory();
  const first = await run({ output, now: NOW, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: live });
  assert.equal(first.refresh.freshness, "current");
  const original = await readFile(output, "utf8");
  const second = await run({ output, now: NOW + 3600000, apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: live });
  assert.equal(snapshotIsPublishable(second), true);
  assert.equal(await readFile(output, "utf8"), original);
});

test("cash close and Beijing deadline follow New York daylight saving and early closes", () => {
  assert.equal(new Date(cashCloseUtc("2026-11-03").closeAt).toISOString(), "2026-11-03T21:00:00.000Z");
  assert.equal(new Date(beijingMorningDeadline(cashCloseUtc("2026-11-03").closeAt)).toISOString(), "2026-11-04T00:00:00.000Z");
  assert.equal(new Date(cashCloseUtc("2026-03-09").closeAt).toISOString(), "2026-03-09T20:00:00.000Z");
  assert.equal(new Date(beijingMorningDeadline(cashCloseUtc("2026-03-09").closeAt)).toISOString(), "2026-03-10T00:00:00.000Z");
  assert.equal(cashCloseUtc("2026-11-27").earlyClose, true);
  assert.equal(new Date(cashCloseUtc("2026-11-27").closeAt).toISOString(), "2026-11-27T18:00:00.000Z");
  const before = watchPlan(Date.parse("2026-11-03T18:24:00Z"));
  assert.equal(before.phase, "wait");
  assert.equal(before.targetDate, "2026-11-03");
  assert.equal(new Date(before.waitUntil).toISOString(), "2026-11-03T21:10:00.000Z");
  assert.equal(new Date(before.deadline).toISOString(), "2026-11-04T00:00:00.000Z");
  const summer = watchPlan(Date.parse("2026-07-15T18:00:00Z"));
  assert.equal(summer.phase, "wait");
  assert.equal(new Date(summer.waitUntil).toISOString(), "2026-07-15T20:10:00.000Z");
  const late = watchPlan(Date.parse("2026-11-04T00:48:00Z"));
  assert.equal(late.phase, "final");
  assert.equal(late.targetDate, "2026-11-03");
});

test("Nasdaq official close supplies the session when the historical table is still behind", async () => {
  const now = Date.parse("2026-11-03T21:20:00Z");
  const snapshot = await updateSnapshot({
    previous: { symbols: { QQQI: { price_history: [{ date: "2026-11-02", close: 51.05 }] } } },
    now, apiKey: "", priceAttempts: 1, waiter: async () => {}, fetcher: fetcher({
    nasdaqHistorical: { QQQI: [{ date: "11/02/2026", close: "$51.05" }] },
    nasdaqInfo: { QQQI: { lastSalePrice: "$51.31", lastTradeTimestamp: "Closed at Nov 3, 2026 4:00 PM ET" } },
    alphaFails: ["QQQI"],
  }) });
  const row = snapshot.symbols.QQQI;
  assert.equal(row.price.price, 51.31);
  assert.equal(row.price.price_date, "2026-11-03");
  assert.equal(row.price.source, "Nasdaq official close");
  assert.equal(row.price_status, "valid");
  assert.equal(row.price.change, 0.26);
  assert.equal(snapshot.refresh.price_attempts.some((entry) => entry.symbol === "QQQI" && entry.source === "Alpha Vantage"), false);
});

test("a pre-close run waits for the New York bell and does not publish the previous session as done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-"));
  const output = join(dir, "market.json");
  let clock = Date.parse("2026-11-03T18:24:00Z");
  const waits = [];
  const base = withXqqiHistory();
  const fetcherForClock = async (url, opts) => {
    const text = String(url);
    if (text.includes("/historical")) return response({ data: { tradesTable: { rows: [{ date: "11/02/2026", close: "$51.05" }] } } });
    if (text.includes("/info")) {
      const closed = clock >= Date.parse("2026-11-03T21:00:00Z");
      return response({ data: { secondaryData: { lastSalePrice: closed ? "$51.31" : "$51.05", lastTradeTimestamp: closed ? "Closed at Nov 3, 2026 4:00 PM ET" : "Closed at Nov 2, 2026 4:00 PM ET" } } });
    }
    return base(url, opts);
  };
  const result = await runWatch({
    output, apiKey: "test", pollMs: 60_000, priceAttempts: 1, retryDelays: [], alphaMinIntervalMs: 0,
    now: () => clock,
    waiter: async (ms) => { waits.push(ms); clock += ms; },
    fetcher: fetcherForClock,
  });
  assert.equal(waits.length, 1);
  assert.equal(waits[0], Date.parse("2026-11-03T21:10:00Z") - Date.parse("2026-11-03T18:24:00Z"));
  assert.equal(result.fresh, true);
  assert.equal(result.snapshot.refresh.target_price_date, "2026-11-03");
  assert.equal(result.snapshot.symbols.QQQI.price.price, 51.31);
  assert.equal(result.snapshot.symbols.SPYI.price.price_date, "2026-11-03");
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.refresh.freshness, "current");
  assert.equal(written.symbols.SCHD.price.price_date, "2026-11-03");
});

test("after the Beijing deadline a missing session is stale instead of a successful previous close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "deadline-"));
  const output = join(dir, "market.json");
  const prior = withXqqiHistory({
    nasdaqInfo: Object.fromEntries(["QQQI", "SPYI", "QNDX", "SCHD", "XQQI"].map((symbol) => [symbol, { lastSalePrice: "$10", lastTradeTimestamp: "Closed at Nov 2, 2026 4:00 PM ET" }])),
  });
  await run({ output, now: Date.parse("2026-11-03T18:00:00Z"), apiKey: "test", priceAttempts: 1, waiter: async () => {}, fetcher: prior });
  let clock = Date.parse("2026-11-04T00:48:00Z");
  const stalled = async (url, opts) => {
    if (String(url).includes("/info") || String(url).includes("/historical")) {
      if (String(url).includes("/info")) return response({ data: { secondaryData: { lastSalePrice: "$10", lastTradeTimestamp: "Closed at Nov 2, 2026 4:00 PM ET" } } });
      return response({ data: { tradesTable: { rows: [{ date: "11/02/2026", close: "$10" }] } } });
    }
    return prior(url, opts);
  };
  const result = await runWatch({
    output, apiKey: "", priceAttempts: 1, retryDelays: [], pollMs: 60_000,
    now: () => clock,
    waiter: async (ms) => { clock += ms; },
    fetcher: stalled,
  });
  assert.equal(result.fresh, false);
  assert.equal(result.plan.phase, "final");
  assert.equal(result.snapshot.refresh.freshness, "stale");
  assert.equal(result.snapshot.refresh.target_price_date, "2026-11-03");
  const written = JSON.parse(await readFile(output, "utf8"));
  assert.equal(written.symbols.QQQI.price_status, "stale");
  assert.equal(written.symbols.QQQI.price.price_date, "2026-11-02");
  assert.equal(written.refresh.freshness, "stale");
});
