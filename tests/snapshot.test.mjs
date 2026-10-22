import test from "node:test";
import assert from "node:assert/strict";
import { latestCompletedUsTradingSession, isEarlyClose, isUsTradingDay } from "../market-calendar.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSnapshot, fetchYahooPrice, fetchNeosDividends, fetchNeosDistributionRate, fetchNeosPrice, snapshotIsPublishable, run } from "../scripts/update-market-data.mjs";

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
  assert.equal(await readFile(output, "utf8"), original);
});
