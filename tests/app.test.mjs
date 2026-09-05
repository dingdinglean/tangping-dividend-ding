import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const source = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/^import .*\n/, "").split('if ("serviceWorker" in navigator)')[0];
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-09-05T12:00:00Z"])); }
  static now() { return new Date("2026-09-05T12:00:00Z").getTime(); }
}
function app(saved) {
  const storage = new Map(saved ? [["tangping-dividend.v1", JSON.stringify(saved)]] : []);
  const context = vm.createContext({ Date: FixedDate, crypto: webcrypto, structuredClone, Intl, URL,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    navigator: { onLine: true }, document: { visibilityState: "visible" }, setTimeout, clearTimeout,
    configureMarketEndpoint() {}, wait: async () => {}, console });
  vm.runInContext(source, context);
  vm.runInContext('render = () => {}; showToast = () => {};', context);
  return { run: (code) => vm.runInContext(code, context), context, storage };
}
function fixture() {
  return { version: 1, settings: { marketDataMode: "direct", alphaVantageApiKey: "TEST-ONLY", exchangeRate: 7, autoRefresh: true, customSetting: "keep" },
    assets: [{ id: "a", ticker: "TEST", frequency: "monthly", currentPrice: 100, manualDividendYieldPercent: 12, remoteDividends: [] }],
    transactions: [{ id: "b", assetId: "a", type: "buy", date: "2026-01-01", shares: 100, price: 90 }] };
}

test("v1 migration preserves assets, transactions, key and unknown settings", () => {
  const saved = fixture(); const a = app(saved);
  a.run("saveState()"); const stored = JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.deepEqual(stored.transactions, saved.transactions);
  assert.equal(stored.assets[0].currentPrice, 100);
  assert.equal(stored.settings.alphaVantageApiKey, "TEST-ONLY");
  assert.equal(stored.settings.customSetting, "keep");
  assert.equal(stored.settings.freedomMilestones.length, 6);
});
test("future monthly projections are derived, not persisted; sold holdings project zero", () => {
  const a = app(fixture());
  const chart = a.run("monthlyIncomeData(2026)");
  assert.equal(chart.forecast.length, 12);
  assert.deepEqual(Array.from(chart.forecast), [0,0,0,0,0,0,0,0,100,100,100,100]);
  assert.equal(a.run("state.transactions.length"), 1);
  a.run('state.transactions.push({assetId:"a", type:"sell", date:"2026-09-01",shares:100})');
  assert.equal(a.run("monthlyIncomeData(2026).forecast.reduce((a,b)=>a+b,0)"), 0);
});
test("announcement replaces projection and annual total sums actual + announced + forecast", () => {
  const a = app(fixture());
  a.run('state.transactions.push({assetId:"a",type:"dividend",date:"2026-09-20",status:"announced",netDividend:90}, {assetId:"a",type:"dividend",date:"2026-04-01",status:"received",netDividend:50})');
  const chart = a.run("monthlyIncomeData(2026)");
  assert.equal(chart.forecast[8], 0); assert.equal(chart.announced[8], 90);
  assert.equal([...chart.received,...chart.announced,...chart.forecast].reduce((a,b)=>a+b), 440);
  assert.equal(a.run("getMonthlyPassiveIncomeUsd(calculatePortfolio().totals)"), 100);
});
test("quarterly schedule follows history, unknown schedule remains blank", () => {
  const a = app(fixture()); a.run('state.assets[0].frequency="quarterly"');
  assert.equal(a.run("monthlyIncomeData(2026).forecast.reduce((a,b)=>a+b,0)"), 0);
  a.run('state.assets[0].remoteDividends=[{exDate:"2026-06-20",paymentDate:"2026-06-30",amount:3}]');
  assert.deepEqual(Array.from(a.run("monthlyIncomeData(2026).forecast")), [0,0,0,0,0,0,0,0,300,0,0,300]);
});
test("all six milestone boundaries unlock; display currency doesn't affect CNY judgment", () => {
  const a = app(fixture());
  for (const [i, value] of [150,400,2500,6000,12000,20000].entries()) {
    assert.equal(a.run(`getFreedomStatus(${value}).milestones.filter(x=>x.unlocked).length`), i+1);
    assert.equal(a.run(`getFreedomStatus(${value-0.01}).milestones.filter(x=>x.unlocked).length`), i);
  }
  a.run('state.settings.displayCurrency="USD"');
  assert.equal(a.run('getFreedomStatus(getMonthlyPassiveIncomeUsd(calculatePortfolio().totals)*state.settings.exchangeRate).current.name'), "水电自由");
});
test("delete cancellation and cascading deletion with backup", () => {
  const a = app(fixture());
  a.context.confirm = () => false; a.run('deleteAsset("a")'); assert.equal(a.run("state.assets.length"),1);
  a.context.confirm = (text) => { assert.match(text,/买入 1 笔/); return true; };
  a.run('deleteAsset("a")');
  assert.equal(a.run("state.assets.length"),0); assert.equal(a.run("state.transactions.length"),0);
  assert.equal(JSON.parse(a.storage.get("tangping-dividend.backup-before-delete")).state.transactions.length,1);
});
test("delete empty asset and failure to back up aborts deletion", () => {
  const a = app(fixture()); a.context.confirm = () => true;
  a.run('state.assets.push({id:"empty",ticker:"EMPTY"}); deleteAsset("empty")');
  assert.equal(a.run("state.assets.length"),1);
  a.context.localStorage.setItem = () => { throw new Error("quota"); };
  a.run('deleteAsset("a")'); assert.equal(a.run("state.assets.length"),1);
});
test("actual received amounts never overwritten by remote announcements; deleted assets cannot create orphans", () => {
  const a = app(fixture());
  a.run('state.transactions.push({assetId:"a",type:"dividend",date:"2026-09-20",exDate:"2026-09-10",status:"received",netDividend:42,perShare:1}); state.assets[0].remoteDividends=[{exDate:"2026-09-10",paymentDate:"2026-09-20",amount:1}]; syncDeclaredDividendTransactions(state.assets[0]);');
  assert.equal(a.run("state.transactions[1].netDividend"),42);
  a.run('const deleted=state.assets[0];state.assets=[];state.transactions=[];syncDeclaredDividendTransactions(deleted)');
  assert.equal(a.run("state.transactions.length"),0);
});
test("requests have a durable 25/day budget; proxy does not consume personal budget", () => {
  const a=app(fixture()); a.run('state.settings.apiUsageDate=todayKey();state.settings.apiUsageCount=24;consumeApiRequest()');
  assert.throws(()=>a.run('consumeApiRequest()'),/预算/);
  assert.equal(JSON.parse(a.storage.get("tangping-dividend.v1")).settings.apiUsageCount,25);
  a.run('state.settings.marketDataMode="proxy";state.settings.marketDataEndpoint="https://example.com/api/market";consumeApiRequest()');
  assert.equal(a.run('state.settings.apiUsageCount'),25);
});
test("resource freshness ignores global success; failures back off independently", () => {
  const a=app(fixture());
  a.run('state.settings.lastMarketRefreshAt=new Date().toISOString();state.assets[0].priceUpdatedAt=new Date().toISOString()');
  assert.equal(a.run('resourceDue(state.assets[0],"price")'),false);
  assert.equal(a.run('resourceDue(state.assets[0],"dividend")'),true);
  a.run('state.assets[0].dividendAttemptAt=new Date().toISOString()');
  assert.equal(a.run('resourceDue(state.assets[0],"dividend")'),false);
});
test("automatic refresh requests only stale resources and can run again after reconnect", async () => {
  const a=app(fixture()); let quoteCalls=0, dividendCalls=0;
  a.context.fetchAlphaQuote=async()=>{quoteCalls++;return {price:101};};
  a.context.fetchAlphaDividends=async()=>{dividendCalls++;return {dividends:[{exDate:"2026-08-01",amount:1}],source:"test"};};
  a.context.fetchUsdCnyRate=async()=>({rate:7,date:"2026-09-05"});
  a.run('state.assets[0].dividendUpdatedAt=new Date().toISOString()');
  await a.run('maybeAutoRefresh()'); assert.equal(quoteCalls,1); assert.equal(dividendCalls,0);
  a.run('state.assets[0].priceUpdatedAt=null; state.assets[0].priceAttemptAt=null; lastAutoCheck=0');
  await a.run('maybeAutoRefresh()'); assert.equal(quoteCalls,2);
});
test("background completion preserves modal/settings forms", () => {
  const a=app(fixture()); let renders=0; a.context.render=()=>{renders++;};
  a.run('modal={type:"asset"};renderAfterSync()'); assert.equal(renders,0);
  a.run('modal=null;currentTab="settings";renderAfterSync()'); assert.equal(renders,0);
  a.run('currentTab="home";renderAfterSync()'); assert.equal(renders,1);
});
test("chart uses pixel heights and doesn't squash bars to an enormous goal", () => {
  const a=app(fixture()); const html=a.run('renderIncomeChart(monthlyIncomeData(2026),99999999)');
  assert.equal((html.match(/class="bar-group"/g)||[]).length,12);
  assert.match(html,/height:160\.714/);
});

test("unreadable stored data is never overwritten by fallback defaults", () => {
  const a=app(fixture()); a.storage.set("tangping-dividend.v1","{broken-json");
  a.run("state=loadState()");
  assert.throws(()=>a.run("saveState()"),/停止写入/);
  assert.equal(a.storage.get("tangping-dividend.v1"),"{broken-json");
});
test("quota failure stops fallback waterfall and missing price doesn't create a complete valuation",async()=>{
  const a=app(fixture()); let calls=0;
  a.context.fetchAlphaQuote=async()=>{calls++;throw new Error("行情请求额度已用完");};
  a.context.fetchAlphaDividends=async()=>{calls++;throw new Error("should not call");};
  await assert.rejects(a.run("updateAssetMarketData(state.assets[0])"),/额度/);
  assert.equal(calls,1);
  a.run("state.assets[0].currentPrice=0");
  assert.equal(a.run("calculatePortfolio().totals.priceCoverageComplete"),false);
});

test("legacy settings migrate to Actions default without deleting personal key or endpoint",()=>{
  const saved=fixture(); delete saved.settings.marketDataMode;
  saved.settings.marketDataEndpoint="https://example.com/api/market";
  const a=app(saved);a.run("saveState()");
  assert.equal(a.run("getMarketEndpoint()"),"./data/market.json");
  const stored=JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.equal(stored.settings.alphaVantageApiKey,"TEST-ONLY");
  assert.equal(stored.settings.marketDataEndpoint,saved.settings.marketDataEndpoint);
  assert.deepEqual(stored.transactions,saved.transactions);
});
