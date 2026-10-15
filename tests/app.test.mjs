import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { APP_VERSION } from "../pwa-release.js";

const source = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/^(?:import[^\r\n]*\r?\n)+/, "").split('if ("serviceWorker" in navigator)')[0];
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-09-05T12:00:00Z"])); }
  static now() { return new Date("2026-09-05T12:00:00Z").getTime(); }
}
function app(saved, { systemDark = false } = {}) {
  const storage = new Map(saved ? [["tangping-dividend.v1", JSON.stringify(saved)]] : []);
  const themeColor = { content: "#f4f4f6" };
  const documentElement = { dataset: {}, style: {} };
  const mediaQuery = { matches: systemDark, addEventListener(type, listener) { if (type === "change") this.listener = listener; } };
  const context = vm.createContext({ Date: FixedDate, crypto: webcrypto, structuredClone, Intl, URL,
    FormData: class { constructor(target) { this.pairs = Object.entries(target?.fields || {}); } [Symbol.iterator]() { return this.pairs[Symbol.iterator](); } },
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    navigator: { onLine: true }, window: { matchMedia: () => mediaQuery }, document: { visibilityState: "visible", documentElement, querySelector: (selector) => selector === 'meta[name="theme-color"]' ? themeColor : null }, setTimeout, clearTimeout,
    APP_VERSION,
    latestCompletedUsTradingSession: () => ({ date: "2026-09-04" }),
    configureMarketEndpoint() {}, refreshSnapshot: async () => "test-snapshot", wait: async () => {}, console });
  vm.runInContext(source, context);
  vm.runInContext('render = () => {}; showToast = () => {};', context);
  return { run: (code) => vm.runInContext(code, context), context, storage, themeColor, documentElement, mediaQuery };
}
function fixture() {
  return { version: 1, settings: { marketDataMode: "direct", alphaVantageApiKey: "TEST-ONLY", exchangeRate: 7, autoRefresh: true, customSetting: "keep" },
    assets: [{ id: "a", ticker: "TEST", frequency: "monthly", currentPrice: 100, priceDate: "2026-09-04", manualDividendYieldPercent: 12, remoteDividends: [] }],
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
  const a=app(fixture()); a.run('state.settings.marketDataMode="direct";state.settings.apiUsageDate=todayKey();state.settings.apiUsageCount=24;consumeApiRequest()');
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
  a.context.fetchAlphaQuote=async()=>{quoteCalls++;return {price:101,tradingDay:"2026-09-04",priceDate:"2026-09-04",source:"test"};};
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
test("chart uses the proportional visual pixel height and doesn't squash bars to an enormous goal", () => {
  const a=app(fixture()); const html=a.run('renderIncomeChart(monthlyIncomeData(2026),99999999)');
  assert.equal((html.match(/class="bar-group"/g)||[]).length,12);
  assert.match(html,/height:71\.428/);
});

test("chart months are accessible controls and start without a selected amount", () => {
  const a = app(fixture());
  const html = a.run("renderIncomeChart(monthlyIncomeData(2026), 100)");
  assert.equal((html.match(/data-chart-month=/g) || []).length, 12);
  assert.equal((html.match(/aria-pressed="false"/g) || []).length, 12);
  assert.match(html, /class="chart-tooltip"[^>]*aria-hidden="true"><\/div>/);
  assert.match(html, /data-count-key="year-received"/);
});

test("bell includes only announced receipts that are due, and the inbox never confirms automatically", () => {
  const a = app(fixture());
  a.run(`state.transactions.push(
    { id: "due", assetId: "a", type: "dividend", status: "announced", date: "2026-09-01", netDividend: 50 },
    { id: "future", assetId: "a", type: "dividend", status: "announced", date: "2026-10-01", netDividend: 60 },
    { id: "forecast", assetId: "a", type: "dividend", status: "forecast", date: "2026-09-01", netDividend: 70 },
    { id: "received", assetId: "a", type: "dividend", status: "received", date: "2026-09-01", netDividend: 80 })`);
  const before = a.run("JSON.stringify(state.transactions)");
  assert.match(a.run("renderDividendBell()"), /待确认股息，1 笔/);
  assert.match(a.run("renderDividendInboxModal()"), /data-pending-id="due"/);
  assert.doesNotMatch(a.run("renderDividendInboxModal()"), /data-pending-id="future"|data-pending-id="forecast"|data-pending-id="received"/);
  assert.equal(a.run("JSON.stringify(state.transactions)"), before);
  assert.equal(a.run("modal"), null);
});

test("confirming saves one existing record, reduces the bell, updates received chart data and returns to the inbox", () => {
  const a = app(fixture());
  const timers = [];
  a.context.setTimeout = callback => { timers.push(callback); return 1; };
  a.run(`state.transactions.push({id:"due",assetId:"a",type:"dividend",status:"announced",date:"2026-09-04",grossDividend:100,taxAndFees:25,netDividend:75});
    modal={type:"confirm-dividend",transactionId:"due",returnToInbox:true};
    submitConfirmDividend({preventDefault(){},currentTarget:{fields:{transactionId:"due",actualDate:"2026-09-04",grossDividend:"100",taxAndFees:"30",netDividend:"70",note:"test"}}})`);
  assert.equal(a.run("getPendingDividendTransactions().length"), 0);
  assert.equal(a.run("calculatePortfolio().totals.received"), 70);
  assert.equal(a.run("monthlyIncomeData(2026).received[8]"), 70);
  assert.equal(a.run("monthlyIncomeData(2026).announced[8]"), 0);
  assert.equal(a.run("state.transactions.length"), 2);
  assert.equal(a.run("modal.confirmationDone"), true);
  assert.match(a.run('renderConfirmDividendModal("due")'), /✓ 已收到/);
  const saved = JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.equal(saved.transactions.find(tx => tx.id === "due").netDividend, 70);
  assert.equal(saved.transactions.find(tx => tx.id === "due").status, "received");
  assert.equal(app(saved).run("calculatePortfolio().totals.received"), 70);
  timers[0]();
  assert.equal(a.run("modal.type"), "dividend-inbox");
  assert.match(a.run("renderDividendInboxModal()"), /暂无待确认股息/);
});

test("a failed receipt save preserves the announced record instead of showing false success", () => {
  const a = app(fixture());
  a.run(`state.transactions.push({id:"due",assetId:"a",type:"dividend",status:"announced",date:"2026-09-04",grossDividend:100,taxAndFees:25,netDividend:75});
    modal={type:"confirm-dividend",transactionId:"due"}`);
  const before = a.run('JSON.stringify(state.transactions.find(tx => tx.id === "due"))');
  a.context.localStorage.setItem = () => { throw new Error("quota"); };
  a.run('submitConfirmDividend({preventDefault(){},currentTarget:{fields:{transactionId:"due",actualDate:"2026-09-04",grossDividend:"100",taxAndFees:"30",netDividend:"70"}}})');
  assert.equal(a.run('JSON.stringify(state.transactions.find(tx => tx.id === "due"))'), before);
  assert.equal(a.run("Boolean(modal.confirmationDone)"), false);
});

test("unavailable dividend data is insufficient, not a false 0% forecast", () => {
  const saved = fixture();
  saved.assets[0].manualDividendYieldPercent = null;
  saved.assets[0].dividendLastError = "静态行情未提供有效股息";
  const a = app(saved);
  assert.equal(a.run("calculatePortfolio().positions[0].dividendKnownZero"), false);
  assert.equal(a.run("calculatePortfolio().positions[0].annualForecast"), 0);
  assert.equal(a.run("calculatePortfolio().totals.dividendCoverageComplete"), false);
  assert.match(a.run("renderPortfolio()"), /待更新/);
});

test("a failed dividend-rate refresh preserves the last valid rate and marks it stale", async () => {
  const a = app(fixture());
  a.run('Object.assign(state.assets[0], { dividendRate: 0.0044, dividendRateDate: "2026-09-17", dividendRateKind: "30_day_sec_yield", dividendRateYieldType: "30 Day SEC Yield", dividendCoverage: "complete", dividendRateStale: false })');
  a.context.fetchAlphaQuote = async () => ({ price: 101, tradingDay: "2026-09-04", priceDate: "2026-09-04", source: "test" });
  a.context.fetchAlphaDividends = async () => ({ dividends: [{ exDate: "2026-09-01", amount: 1 }], source: "test" });
  a.context.fetchAlphaMonthlyAdjustedDividends = async () => ({ dividends: [], source: "test" });
  a.context.fetchAlphaOverviewDividend = async () => { throw new Error("upstream unavailable"); };
  await a.run('updateAssetMarketData(state.assets[0])');
  assert.equal(a.run("state.assets[0].dividendRate"), 0.0044);
  assert.equal(a.run("state.assets[0].dividendRateStale"), true);
  assert.equal(a.run("state.assets[0].dividendRateYieldType"), "30 Day SEC Yield");
  a.run("state.assets[0].manualDividendYieldPercent = null");
  assert.match(a.run("renderAssetCard(calculatePortfolio().positions[0])"), /30 Day SEC Yield · 09\/17 · 已过期，沿用上次/);
});

test("a legacy zero manual yield cannot hide QNDX's verified 30 Day SEC Yield", () => {
  const saved = fixture();
  Object.assign(saved.assets[0], {
    ticker: "QNDX",
    name: "State Street SPDR Portfolio Nasdaq 100 ETF",
    manualDividendYieldPercent: 0,
    dividendRate: 0.0044,
    dividendRateDate: "2026-09-17",
    dividendRateKind: "30_day_sec_yield",
    dividendRateYieldType: "30 Day SEC Yield",
  });
  const a = app(saved);
  assert.equal(a.run("calculatePortfolio().positions[0].manualYield"), null);
  assert.equal(a.run("calculatePortfolio().positions[0].dividendYield"), 0.0044);
  const html = a.run("renderAssetCard(calculatePortfolio().positions[0])");
  assert.match(html, />0\.44%<\/strong>/);
  assert.match(html, /30 Day SEC Yield · 09\/17/);
  assert.doesNotMatch(html, />0\.00%<\/strong>/);
});

test("ETF cards preserve percentage units and render each published yield type", () => {
  const cases = [
    ["QQQI", 0.1439, "2026-08-31", "distribution_rate", "distribution_rate", "14.39%", "Distribution Rate · 08/31"],
    ["SPYI", 0.1215, "2026-08-31", "distribution_rate", "distribution_rate", "12.15%", "Distribution Rate · 08/31"],
    ["SCHD", 0.03111638954869359, "2026-06-24", "ttm_distribution_yield", "TTM Distribution Yield", "3.11%", "TTM Distribution Yield · 06/24"],
  ];
  for (const [ticker, rate, date, kind, yieldType, displayedRate, caption] of cases) {
    const saved = fixture();
    Object.assign(saved.assets[0], { ticker, manualDividendYieldPercent: null, dividendRate: rate, dividendRateDate: date, dividendRateKind: kind, dividendRateYieldType: yieldType });
    const a = app(saved);
    const html = a.run("renderAssetCard(calculatePortfolio().positions[0])");
    assert.match(html, new RegExp(`>${displayedRate.replace(".", "\\.")}</strong>`));
    assert.match(html, new RegExp(caption.replace(".", "\\.")));
  }
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

test("a prior close still values the holding, and a missing price stays out of the total", () => {
  const a = app(fixture());
  a.run(`state.settings.exchangeRateUpdatedAt=new Date().toISOString();
    Object.assign(state.assets[0], { currentPrice: 56.27, priceDate: "2026-09-03", priceTradingDay: "2026-09-03", priceSource: "Nasdaq historical close", manualDividendYieldPercent: null, dividendRate: 0.1428, dividendRateDate: "2026-08-31", dividendRateKind: "distribution_rate", dividendRateYieldType: "Distribution Rate", dividendCoverage: "complete" });
    state.assets.push({id:"none",ticker:"NONE",frequency:"monthly",currentPrice:0,priceDate:null,manualDividendYieldPercent:null,remoteDividends:[]});
    state.transactions.push({assetId:"none",type:"buy",date:"2026-01-01",shares:10,price:180})`);
  assert.equal(a.run("calculatePortfolio().totals.marketValue"), 5627);
  assert.ok(a.run("calculatePortfolio().totals.annualForecast") > 800);
  assert.equal(a.run("calculatePortfolio().totals.priceCoverageComplete"), false);
  assert.equal(a.run("calculatePortfolio().totals.carriedCloseCount"), 1);
  assert.match(a.run("renderPortfolio()"), /待更新/);
  const home = a.run("renderHome()");
  assert.match(home, /沿用上一交易日收盘价 · 2026-09-03/);
  assert.doesNotMatch(home, /按各标的自身口径估算/);
  assert.match(home, /部分标的待更新/);
  const card = a.run("renderAssetCard(calculatePortfolio().positions[0])");
  assert.match(card, /沿用上一交易日收盘价 · 09\/03/);
  assert.match(card, /status-dot stale/);
  assert.equal(a.run('priceStatusText(state.assets[0]).startsWith("沿用上一交易日收盘价")'), true);
  a.run('state.assets[0].priceDate="2026-09-04"; state.assets[0].priceTradingDay="2026-09-04"');
  assert.match(a.run("priceStatusText(state.assets[0])"), /^收盘价 · 09\/04/);
  assert.equal(a.run("usesPriorClose(state.assets[0])"), false);
  assert.match(a.run("renderAssetCard(calculatePortfolio().positions[0])"), /status-dot fresh/);
  assert.doesNotMatch(a.run("renderHome()"), /沿用上一交易日收盘价/);
});

test("compact settings keeps all seven actions without user-visible release information", () => {
  const a = app(fixture());
  const empty = a.run("renderSettings()");
  assert.doesNotMatch(empty, /settings-about|行情自动更新，实际到账需本人确认|升级前建议导出/);
  assert.doesNotMatch(empty, new RegExp(`v${APP_VERSION}`));
  for (const action of ["open-display-settings", "open-theme-settings", "open-goal-settings", "open-milestone-settings", "export-data", "import-data", "reset-data"]) assert.match(empty, new RegExp(`data-action="${action}"`));
  assert.equal((empty.match(/settings-menu-row/g) || []).length, 7);
  a.run('state.settings.lastBackupAt="2026-09-01T00:00:00.000Z"');
  assert.doesNotMatch(a.run("renderSettings()"), /升级前建议导出/);
});

test("compact home has three regions, complete money and a bounded monthly goal progress", () => {
  const a = app(fixture());
  const before = a.run("JSON.stringify(state)");
  const html = a.run("renderHome()");
  assert.equal((html.match(/<section class="card/g) || []).length, 3);
  assert.match(html, /income-facts/);
  assert.match(html, /预期现金流\/市值/);
  assert.doesNotMatch(html, /home-yield-grid|预期现金流\/成本|按各标的自身口径/);
  for (const key of ["monthly-income", "received-income", "annual-forecast", "chart-total", "year-received"]) assert.match(html, new RegExp(`data-count-key="${key}"`));
  a.run("state.settings.monthlyGoal=1");
  assert.match(a.run("renderHome()"), /aria-label="月收入目标进度"[^>]*aria-valuenow="100.0"/);
  a.run("state.settings.monthlyGoal=1000");
  assert.equal(a.run("JSON.stringify(state)"), before);
});

test("cash flow on cost moves to portfolio while retaining its exact formula", () => {
  const a = app(fixture());
  const rate = a.run("(calculatePortfolio().totals.annualForecast/calculatePortfolio().totals.cost*100).toFixed(2)");
  assert.match(a.run("renderPortfolio()"), new RegExp(`预期现金流/成本</span><strong>${rate}%`));
  a.run('state.settings.displayCurrency="USD"');
  assert.match(a.run("renderPortfolio()"), new RegExp(`预期现金流/成本</span><strong>${rate}%`));
});

test("clean topbars retain currency, bell and add controls with SVG navigation", () => {
  const a = app(fixture());
  assert.match(a.run("renderTopbar()"), /躺平股息/);
  assert.doesNotMatch(a.run("renderTopbar()"), /今天离海边|<p>/);
  for (const action of ["open-dividend-inbox", "toggle-currency", "open-add"]) assert.match(a.run("renderTopbar()"), new RegExp(action));
  assert.equal((a.run("renderBottomNav()").match(/<svg/g) || []).length, 4);
  assert.doesNotMatch(a.run("renderBottomNav()"), /open-add/);
});

test("currency display changes no stored values and milestone progress still uses CNY", () => {
  const a = app(fixture());
  const chart = JSON.stringify(a.run("monthlyIncomeData(2026)"));
  const progress = a.run("getFreedomStatus(700).progress");
  a.run('state.settings.displayCurrency="USD"');
  assert.match(a.run("renderHome()"), /data-count-key="monthly-income" data-count-value="100" data-count-currency="USD"/);
  assert.equal(a.run("getFreedomStatus(700).progress"), progress);
  assert.equal(JSON.stringify(a.run("monthlyIncomeData(2026)")), chart);
});

test("clear-data action still requires confirmation and cancellation never writes", () => {
  const a = app(fixture());
  const before = a.run("JSON.stringify(state)");
  let asked = 0;
  a.context.confirm = () => { asked++; return false; };
  a.run("resetData()");
  assert.equal(asked, 1);
  assert.equal(a.run("JSON.stringify(state)"), before);
  assert.equal(a.storage.get("tangping-dividend.v1"), JSON.stringify(fixture()));
});

test("release upgrade rewrites neither the storage key nor saved transactions", () => {
  const saved = fixture();
  const a = app(saved);
  a.run("saveState()");
  const stored = JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.equal(stored.transactions[0].id, "b");
  assert.equal(stored.assets[0].ticker, "TEST");
  assert.equal(a.storage.has("tangping-dividend.backup-before-delete"), false);
  assert.notEqual(`tangping-dividend-v${APP_VERSION}`, "tangping-dividend.v1");
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

test("system appearance follows the current system mode and updates when it changes", () => {
  const lightSystem = app(fixture(), { systemDark: false });
  lightSystem.run("applyTheme()");
  assert.equal(lightSystem.run("resolvedTheme()"), "light");
  assert.equal(lightSystem.documentElement.dataset.theme, "system");
  assert.equal(lightSystem.themeColor.content, "#f5f5f7");

  const darkSystem = app(fixture(), { systemDark: true });
  darkSystem.run("applyTheme()");
  assert.equal(darkSystem.run("resolvedTheme()"), "dark");
  assert.equal(darkSystem.themeColor.content, "#000000");
  darkSystem.run("initializeTheme()");
  darkSystem.mediaQuery.matches = false;
  darkSystem.mediaQuery.listener();
  assert.equal(darkSystem.run("resolvedTheme()"), "light");
  assert.equal(darkSystem.themeColor.content, "#f5f5f7");
});

test("forced appearance overrides system preference and synchronizes the status color", () => {
  const systemLight = app(fixture(), { systemDark: false });
  systemLight.run('setTheme("dark")');
  assert.equal(systemLight.run("resolvedTheme()"), "dark");
  assert.equal(systemLight.documentElement.style.colorScheme, "dark");
  assert.equal(systemLight.themeColor.content, "#000000");

  const systemDark = app(fixture(), { systemDark: true });
  systemDark.run('setTheme("light")');
  assert.equal(systemDark.run("resolvedTheme()"), "light");
  assert.equal(systemDark.documentElement.style.colorScheme, "light");
  assert.equal(systemDark.themeColor.content, "#f5f5f7");
});

test("appearance persists locally and unknown legacy values safely fall back to system", () => {
  const a = app(fixture());
  a.run('setTheme("dark")');
  const stored = JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.equal(stored.settings.theme, "dark");
  const reopened = app(stored, { systemDark: false });
  assert.equal(reopened.run("state.settings.theme"), "dark");
  assert.equal(reopened.run("currentThemeLabel()"), "深色");
  reopened.run('state.settings.theme="unexpected"');
  assert.equal(reopened.run("normalizeTheme(state.settings.theme)"), "system");
});

test("confirmed dividend net uses whole cents for the requested tax examples", () => {
  const a = app(fixture());
  const result = (grossDividend, taxAndFees) => Number(a.run(`calculatedNetDividendCents("${grossDividend}", "${taxAndFees}")`)) / 100;
  assert.equal(result("55.15", "5.52"), 49.63);
  assert.equal(result("55.16", "0"), 55.16);
  assert.equal(result("55.16", "5.52"), 49.64);
  assert.equal(a.run('formatUsdCents(calculatedNetDividendCents("55.15", "5.52"))'), "49.63");
  a.run('state.transactions.push({id:"confirm-default",assetId:"a",type:"dividend",status:"announced",grossDividend:55.15,taxAndFees:5.52,netDividend:55.16})');
  assert.match(a.run('renderConfirmDividendModal("confirm-default")'), /name="netDividend" step="0\.01" min="0" value="49\.63"/);
});

test("changing gross or withholding recalculates the editable confirmation net field", () => {
  const a = app(fixture());
  const net = a.run(`(() => {
    const form = { elements: { grossDividend: { value: "55.15" }, taxAndFees: { value: "5.52" }, netDividend: { value: "40.00" } } };
    syncConfirmDividendNet(form);
    const afterGross = form.elements.netDividend.value;
    form.elements.taxAndFees.value = "0";
    syncConfirmDividendNet(form);
    return [afterGross, form.elements.netDividend.value];
  })()`);
  assert.deepEqual(Array.from(net), ["49.63", "55.15"]);
});

test("confirmation validates empty, invalid and over-withheld amounts before saving", () => {
  const a = app(fixture());
  const valid = '{actualDate:"2026-09-18",grossDividend:"55.15",taxAndFees:"5.52",netDividend:"49.63"}';
  assert.throws(() => a.run(`confirmedDividendAmounts({...${valid},taxAndFees:"55.16",netDividend:"0.00"})`), /预扣税/);
  assert.throws(() => a.run(`confirmedDividendAmounts({...${valid},grossDividend:"",netDividend:""})`), /实际税前/);
  assert.throws(() => a.run(`confirmedDividendAmounts({...${valid},taxAndFees:"not-a-number"})`), /预扣税/);
  assert.throws(() => a.run(`confirmedDividendAmounts({...${valid},actualDate:""})`), /到账日期/);
});

test("confirmed dividend persists the final displayed net amount used by receipt totals and chart", () => {
  const a = app(fixture());
  const saved = JSON.parse(a.run(`(() => {
    const tx = { id: "confirmed", assetId: "a", type: "dividend", status: "announced", date: "2026-09-10", grossDividend: 55.15, taxAndFees: 5.52, netDividend: 55.16 };
    state.transactions.push(tx);
    confirmDividendRecord(tx, { transactionId: "confirmed", actualDate: "2026-09-18", grossDividend: "55.15", taxAndFees: "5.52", netDividend: "49.63", note: "IBKR" });
    return JSON.stringify({ tx, received: calculatePortfolio().totals.received, september: monthlyIncomeData(2026).received[8] });
  })()`));
  assert.deepEqual(saved.tx, {
    id: "confirmed", assetId: "a", type: "dividend", status: "received", date: "2026-09-18", actualDate: "2026-09-18",
    grossDividend: 55.15, taxAndFees: 5.52, netDividend: 49.63, isEstimatedNet: false, note: "IBKR", confirmedAt: saved.tx.confirmedAt,
  });
  assert.equal(saved.received, 49.63);
  assert.equal(saved.september, 49.63);
});

test("snapshot mode rechecks a misaligned close about every 60 seconds and stays quiet once aligned", async () => {
  const a = app(fixture());
  let quoteCalls = 0;
  a.context.fetchAlphaQuote = async () => { quoteCalls += 1; return { price: 56.27, tradingDay: "2026-09-03", priceDate: "2026-09-03", source: "Nasdaq historical close", fetchedAt: "2026-09-04T09:00:00.000Z" }; };
  a.context.fetchAlphaDividends = async () => ({ dividends: [], source: "test" });
  a.context.fetchAlphaMonthlyAdjustedDividends = async () => ({ dividends: [] });
  a.context.fetchAlphaOverviewDividend = async () => ({ dividendYield: 0.1428, dataDate: "2026-08-31", quality: "distribution_rate", yieldType: "Distribution Rate", coverage: "complete" });
  a.context.fetchUsdCnyRate = async () => ({ rate: 7, date: "2026-09-05", fetchedAt: new Date().toISOString() });
  a.run(`state.settings.marketDataMode="snapshot";
    Object.assign(state.assets[0], { priceDate: "2026-09-03", priceUpdatedAt: new Date().toISOString(), dividendUpdatedAt: new Date().toISOString(), priceAttemptAt: new Date().toISOString(), dividendAttemptAt: new Date().toISOString() });
    lastAutoCheck = 0`);
  assert.equal(a.run("SNAPSHOT_POLL_MS"), 60000);
  assert.equal(a.run('automaticResourceDue(state.assets[0], "price")'), true);
  await a.run("maybeAutoRefresh()");
  assert.equal(quoteCalls, 1);
  a.run("lastAutoCheck = Date.now() - 1000");
  await a.run("maybeAutoRefresh()");
  assert.equal(quoteCalls, 1);
  a.run("lastAutoCheck = Date.now() - 60000");
  await a.run("maybeAutoRefresh()");
  assert.equal(quoteCalls, 2);
  a.run(`Object.assign(state.assets[0], { currentPrice: 56.27, priceDate: "2026-09-04", priceTradingDay: "2026-09-04", priceSource: "Nasdaq historical close", priceUpdatedAt: new Date().toISOString(), dividendUpdatedAt: new Date().toISOString() });
    lastAutoCheck = 0`);
  assert.equal(a.run('automaticResourceDue(state.assets[0], "price")'), false);
  await a.run("maybeAutoRefresh()");
  assert.equal(quoteCalls, 2);
});

test("direct mode keeps the 18 hour budget when the stored close is from a previous session", async () => {
  const a = app(fixture());
  let quoteCalls = 0;
  a.context.fetchAlphaQuote = async () => { quoteCalls += 1; return { price: 56.27, priceDate: "2026-09-04", tradingDay: "2026-09-04" }; };
  a.context.fetchUsdCnyRate = async () => ({ rate: 7, date: "2026-09-05", fetchedAt: new Date().toISOString() });
  a.run(`state.settings.marketDataMode="direct";
    Object.assign(state.assets[0], { priceDate: "2026-09-03", priceUpdatedAt: new Date().toISOString(), dividendUpdatedAt: new Date().toISOString(), priceAttemptAt: new Date().toISOString(), dividendAttemptAt: new Date().toISOString() });
    lastAutoCheck = 0`);
  assert.equal(a.run('automaticResourceDue(state.assets[0], "price")'), false);
  await a.run("maybeAutoRefresh()");
  assert.equal(quoteCalls, 0);
  assert.equal(a.run("state.assets[0].currentPrice"), 100);
});

test("manual price records the latest session date and a manual source", () => {
  const a = app(fixture());
  a.run(`Object.assign(state.assets[0], { currentPrice: 50, priceDate: "2026-09-03", priceSource: "Nasdaq historical close", priceUpdatedAt: "2026-09-03T20:00:00.000Z" });
    submitPrice({ preventDefault() {}, currentTarget: { fields: { assetId: "a", currentPrice: "56.5" } } })`);
  assert.equal(a.run("state.assets[0].currentPrice"), 56.5);
  assert.equal(a.run("state.assets[0].priceDate"), "2026-09-04");
  assert.equal(a.run("state.assets[0].priceTradingDay"), "2026-09-04");
  assert.equal(a.run("state.assets[0].priceSource"), "手动");
  const card = a.run("renderAssetCard(calculatePortfolio().positions[0])");
  assert.match(card, /手动价格 · 09\/04/);
  assert.doesNotMatch(card, /沿用上一交易日收盘价/);
  a.run(`Object.assign(state.assets[0], { currentPrice: 100, priceDate: "2026-09-03", priceTradingDay: "2026-09-03", priceSource: "Nasdaq historical close" });
    submitAsset({ preventDefault() {}, currentTarget: { fields: { assetId: "a", ticker: "TEST", apiSymbol: "TEST", name: "Test", assetType: "ETF", frequency: "monthly", role: "现金", manualDividendYieldPercent: "12", currentPrice: "100" } } })`);
  assert.equal(a.run("state.assets[0].priceSource"), "Nasdaq historical close");
  assert.equal(a.run("state.assets[0].priceDate"), "2026-09-03");
});

test("a prior-close refresh keeps confirmed dividends and the existing storage key", async () => {
  const a = app(fixture());
  a.context.fetchAlphaQuote = async () => ({ price: 100, tradingDay: "2026-09-03", priceDate: "2026-09-03", source: "Nasdaq historical close" });
  a.context.fetchAlphaDividends = async () => ({ dividends: [{ exDate: "2026-08-01", paymentDate: "2026-08-05", amount: 9 }], source: "Alpha Vantage Dividends" });
  a.context.fetchAlphaMonthlyAdjustedDividends = async () => ({ dividends: [] });
  a.context.fetchAlphaOverviewDividend = async () => ({ dividendYield: 0.12, dataDate: "2026-08-31", quality: "distribution_rate", yieldType: "Distribution Rate", coverage: "complete" });
  a.run(`state.transactions.push({ id: "recv", assetId: "a", type: "dividend", status: "received", date: "2026-08-01", exDate: "2026-08-01", netDividend: 42, grossDividend: 50, perShare: 0.5 });
    Object.assign(state.assets[0], { priceDate: "2026-09-03", manualDividendYieldPercent: null })`);
  const before = a.run('state.transactions.find((tx) => tx.id === "recv").netDividend');
  await a.run("updateAssetMarketData(state.assets[0])");
  assert.equal(before, 42);
  assert.equal(a.run('state.transactions.find((tx) => tx.id === "recv").netDividend'), 42);
  assert.equal(a.run('state.transactions.find((tx) => tx.id === "recv").status'), "received");
  a.run("saveState()");
  const stored = JSON.parse(a.storage.get("tangping-dividend.v1"));
  assert.equal(stored.transactions.find((tx) => tx.id === "recv").netDividend, 42);
  assert.equal(stored.transactions.filter((tx) => tx.type === "buy").length, 1);
  assert.equal(a.storage.has("tangping-dividend.v2"), false);
});

test("income chart year follows the calendar year instead of a fixed 2026", () => {
  const a = app(fixture());
  assert.equal(a.run("incomeChartYear()"), 2026);
  assert.equal(a.run("incomeChartYear(new Date(2027, 0, 3))"), 2027);
  assert.match(a.run("renderHome()"), /2026 年股息趋势/);
  assert.match(a.run("renderIncomeChart(monthlyIncomeData(2027), 1, 2027)"), /2027 年股息趋势/);
});

test("different published yield types stay labeled separately", () => {
  const a = app(fixture());
  a.run(`state.assets[0].manualDividendYieldPercent = null;
    Object.assign(state.assets[0], { dividendRate: 0.1428, dividendRateDate: "2026-08-31", dividendRateKind: "distribution_rate", dividendRateYieldType: "Distribution Rate", dividendCoverage: "complete" });
    state.assets.push({ id: "s", ticker: "SCHD", frequency: "quarterly", currentPrice: 33.04, priceDate: "2026-09-04", manualDividendYieldPercent: null, dividendRate: 0.0319, dividendRateDate: "2026-06-24", dividendRateKind: "ttm_distribution_yield", dividendRateYieldType: "TTM Distribution Yield", dividendCoverage: "complete", remoteDividends: [] });
    state.transactions.push({ assetId: "s", type: "buy", date: "2026-01-01", shares: 10, price: 30 })`);
  const home = a.run("renderHome()");
  assert.doesNotMatch(home, /各标的口径不同，不是统一股息率/);
  assert.match(home, /预期现金流\/市值/);
  assert.doesNotMatch(home, /价格股息率|成本股息率/);
  assert.match(a.run("renderAssetCard(calculatePortfolio().positions[0])"), /Distribution Rate · 08\/31/);
  assert.match(a.run("renderAssetCard(calculatePortfolio().positions[1])"), /TTM Distribution Yield · 06\/24/);
});


test("a newly published snapshot refreshes already aligned closes without waiting 18 hours", async () => {
  const a = app(fixture()); let version = "first"; let calls = 0;
  a.context.refreshSnapshot = async () => version;
  a.context.fetchAlphaQuote = async () => ({ price: ++calls + 100, priceDate: "2026-09-04", tradingDay: "2026-09-04", source: "test", fetchedAt: new Date().toISOString() });
  a.context.fetchAlphaDividends = async () => ({ dividends: [{exDate:"2026-09-01",amount:1}], source: "test" });
  a.context.fetchAlphaOverviewDividend = async () => ({ dividendYield: .12, coverage: "complete" });
  a.context.fetchAlphaMonthlyAdjustedDividends = async () => ({ dividends: [] });
  a.context.fetchUsdCnyRate = async () => ({ rate: 7, date: "2026-09-05", fetchedAt: new Date().toISOString() });
  a.run('state.settings.marketDataMode="snapshot"');
  await a.run('maybeAutoRefresh()'); assert.equal(calls, 1);
  a.run('lastAutoCheck=0'); await a.run('maybeAutoRefresh()'); assert.equal(calls, 1);
  version = "second";
  a.run('lastAutoCheck=0'); await a.run('maybeAutoRefresh()'); assert.equal(calls, 2);
  assert.equal(a.run('state.assets[0].currentPrice'), 102);
});

test("a lagging snapshot cannot replace a newer verified close or claim full price success", async () => {
  const a = app(fixture());
  a.context.fetchAlphaQuote = async () => ({ price: 1, priceDate: "2026-09-03", tradingDay: "2026-09-03" });
  a.context.fetchAlphaDividends = async () => ({ dividends: [{exDate:"2026-09-01",amount:1}], source: "test" });
  a.context.fetchAlphaOverviewDividend = async () => ({ dividendYield: .12, coverage: "complete" });
  a.context.fetchAlphaMonthlyAdjustedDividends = async () => ({ dividends: [] });
  a.context.fetchUsdCnyRate = async () => ({ rate: 7, date: "2026-09-05", fetchedAt: new Date().toISOString() });
  await a.run('refreshAllData()');
  assert.equal(a.run('state.assets[0].currentPrice'), 100);
  assert.equal(a.run('state.assets[0].priceDate'), "2026-09-04");
  assert.match(a.run('state.settings.lastMarketRefreshMessage'), /快照较旧/);
});
