import test from "node:test";
import assert from "node:assert/strict";
import { updateSnapshot, run, SYMBOLS } from "../scripts/update-market-data.mjs";
import { configureMarketEndpoint, parseSnapshot, snapshotUrls, fetchAlphaQuote, fetchAlphaDividends, fetchAlphaMonthlyAdjustedDividends, fetchAlphaOverviewDividend } from "../market-data.js";

const KEY = "TEST-SECRET-DO-NOT-PUBLISH";
const NOW = Date.parse("2026-09-05T22:37:00Z");
const quote = { "Global Quote": { "05. price": "101", "07. latest trading day": "2026-09-04" } };
const dividends = { data: [{ ex_dividend_date: "2026-09-01", payment_date: "2026-09-10", amount: "1" }] };
const monthly = { "Monthly Adjusted Time Series": { "2026-08-31": { "7. dividend amount": "0.9" } } };
const overview = { DividendPerShare: "12", DividendYield: "0.12", DividendDate: "2026-09-10" };
const response = (body) => ({ ok: true, json: async()=>body });
const payloads = { GLOBAL_QUOTE: quote, DIVIDENDS: dividends, TIME_SERIES_MONTHLY_ADJUSTED: monthly, OVERVIEW: overview };
const updater = (options={})=>updateSnapshot({apiKey:KEY,now:NOW,pause:async()=>{},...options});

test("updater fails clearly before touching files when Secret is missing",async()=>{
  let called=false;
  await assert.rejects(updater({apiKey:"",fetcher:()=>{called=true;}}),/缺少 GitHub Secret ALPHA_VANTAGE_API_KEY/);
  await assert.rejects(run({apiKey:"",output:"DO-NOT-CREATE.json"}),/ALPHA_VANTAGE_API_KEY/);
  assert.equal(called,false);
});
test("updater uses 8 normal calls, only public fields, no secret or personal data",async()=>{
  let calls=0;
  const result=await updater({previous:{transactions:[{shares:99}],alphaVantageApiKey:KEY},fetcher:async(url)=>{
    calls++;const kind=url.searchParams.get("function");
    return response({...payloads[kind],apiKey:KEY,transactions:[{shares:99,buyPrice:42}],user:"private"});
  }});
  assert.equal(calls,8);assert.equal(result.refresh.requests,8);
  assert.deepEqual(Object.keys(result.symbols),SYMBOLS);
  const json=JSON.stringify(result);
  for(const forbidden of [KEY,"transactions","shares","buyPrice","apiKey","user","private"]) assert.ok(!json.includes(forbidden),forbidden);
});
test("failed interface retains last valid quote and timestamp; other symbols update",async()=>{
  const previous=await updater({now:NOW-86400000,fetcher:async(url)=>response(payloads[url.searchParams.get("function")])});
  const result=await updater({previous,fetcher:async(url)=>{
    if(url.searchParams.get("symbol")==="QQQI"&&url.searchParams.get("function")==="GLOBAL_QUOTE") throw new Error(`network failed: apikey=${KEY}`);
    return response(payloads[url.searchParams.get("function")]);
  }});
  assert.deepEqual(result.symbols.QQQI.GLOBAL_QUOTE["Global Quote"],previous.symbols.QQQI.GLOBAL_QUOTE["Global Quote"]);
  assert.equal(result.symbols.QQQI.GLOBAL_QUOTE._fetchedAt,previous.symbols.QQQI.GLOBAL_QUOTE._fetchedAt);
  assert.equal(result.symbols.QQQI.GLOBAL_QUOTE._status,"error");
  assert.equal(result.symbols.SCHD.GLOBAL_QUOTE._fetchedAt,new Date(NOW).toISOString());
  assert.ok(!JSON.stringify(result).includes(KEY));
});
test("fallbacks are only requested when needed; same-day reruns cap total at 25",async()=>{
  let calls=0;
  const fetcher=async(url)=>{calls++;const kind=url.searchParams.get("function");return response(kind==="OVERVIEW"?overview:{Information:"unavailable"});};
  const first=await updater({fetcher});
  assert.equal(calls,16);
  assert.equal(first.symbols.QQQI.OVERVIEW._status,"ok");
  const second=await updater({previous:first,now:NOW+HOUR,fetcher});
  assert.equal(calls,25);assert.equal(second.refresh.requests,25);
  await updater({previous:second,now:NOW+HOUR+60000,fetcher});
  assert.equal(calls,25);
});
const HOUR=3600000;
test("fresh rerun does not mutate snapshot or create writes; budget reserved before fetch",async()=>{
  const first=await updater({fetcher:async(url)=>response(payloads[url.searchParams.get("function")])});
  let writes=0;
  const second=await updater({previous:first,now:NOW+60000,fetcher:()=>{throw new Error("should not request");},onProgress:async()=>writes++});
  assert.deepEqual(first,second);assert.equal(writes,0);
  let reserved=0;
  await updater({onProgress:async(snapshot)=>{reserved=snapshot.refresh.requests;},fetcher:async(url)=>{assert.ok(reserved>0);return response(payloads[url.searchParams.get("function")]);}});
});
test("static parser selects symbol/function and rejects empty/malformed snapshot",()=>{
  const row={...quote,_fetchedAt:"2026-09-04T22:37:00Z",_status:"error"};
  const snapshot={schemaVersion:1,symbols:{QQQI:{GLOBAL_QUOTE:row}}};
  assert.equal(parseSnapshot(snapshot,"QQQI","GLOBAL_QUOTE")._fetchedAt,row._fetchedAt);
  assert.match(parseSnapshot(snapshot,"QQQI","GLOBAL_QUOTE")._refreshWarning,/保留/);
  assert.throws(()=>parseSnapshot(snapshot,"SPYI","GLOBAL_QUOTE"),/尚未生成/);
  assert.throws(()=>parseSnapshot({},"QQQI","GLOBAL_QUOTE"),/格式无效/);
  assert.throws(()=>parseSnapshot(snapshot,"QQQI","bad"),/未知/);
});
test("all four existing parsers reuse one no-store snapshot without sending a key",async()=>{
  const original=globalThis.fetch;let calls=0;
  try {
    configureMarketEndpoint("./data/market.json");
    const records=Object.fromEntries(Object.entries(payloads).map(([key,value])=>[key,{...value,_fetchedAt:new Date(NOW).toISOString(),_status:"ok"}]));
    globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,"./data/market.json");assert.equal(options.cache,"no-store");return response({schemaVersion:1,generatedAt:new Date(NOW).toISOString(),symbols:{QQQI:records}});};
    assert.equal((await fetchAlphaQuote("QQQI",KEY)).price,101);
    assert.equal((await fetchAlphaDividends("QQQI",KEY)).dividends[0].amount,1);
    assert.equal((await fetchAlphaMonthlyAdjustedDividends("QQQI",KEY)).dividends[0].canAutoCreate,false);
    assert.equal((await fetchAlphaOverviewDividend("QQQI",KEY)).annualDividendPerShare,12);
    assert.equal(calls,1);
  } finally {globalThis.fetch=original;configureMarketEndpoint("");}
});
test("Pages resolves newer repository snapshot even if legacy Pages build is old",async()=>{
  const originalFetch=globalThis.fetch;const originalLocation=globalThis.location;
  try {
    globalThis.location={hostname:"dingdinglean.github.io",pathname:"/tangping-dividend-ding/"};
    assert.equal(snapshotUrls().length,2);
    configureMarketEndpoint("./data/market.json");
    globalThis.fetch=async(url)=>response({schemaVersion:1,generatedAt:url.startsWith("https:")?"2026-09-05T22:37:00Z":"2026-09-04T22:37:00Z",symbols:{QQQI:{GLOBAL_QUOTE:{"Global Quote":{"05. price":url.startsWith("https:")?102:101},_fetchedAt:new Date(NOW).toISOString()}}}});
    assert.equal((await fetchAlphaQuote("QQQI")).price,102);
    assert.equal(snapshotUrls({hostname:"localhost",pathname:"/"}).length,1);
  } finally {globalThis.fetch=originalFetch;globalThis.location=originalLocation;configureMarketEndpoint("");}
});
