import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";

// Disposable QA profiles only. Shares/receipts are illustrative, not the user's ledger.
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = resolve(process.env.MOBILE_SOURCE_ROOT || new URL("../", import.meta.url).pathname);
const output = resolve(process.env.UI_SCREENSHOT_DIR || "docs/mobile-qa");
const baseline = process.env.MOBILE_BASELINE === "1";
const snapshot = JSON.parse(await readFile(resolve(root, "data/market.json"), "utf8"));
const tickers = ["QQQI", "SPYI", "QNDX", "SCHD"];
const shares = [60, 40, 20, 1];
const fixture = {
  version: 1,
  settings: { displayCurrency: "CNY", theme: "system", exchangeRate: snapshot.fx.rate, exchangeRateUpdatedAt: snapshot.generatedAt, lastMarketRefreshAt: snapshot.generatedAt, monthlyGoal: 1000, marketDataMode: "snapshot", autoRefresh: true },
  assets: tickers.map((ticker, i) => {
    const record = snapshot.symbols[ticker];
    return { id: ticker, ticker, name: ["NEOS Nasdaq-100 High Income ETF", "NEOS S&P 500 High Income ETF", "State Street SPDR Portfolio Nasdaq 100 ETF", "Schwab U.S. Dividend Equity ETF"][i], type: "ETF", frequency: i < 2 ? "monthly" : "quarterly", remoteDividends: [], currentPrice: record.price.price, priceDate: record.price.price_date, priceUpdatedAt: snapshot.generatedAt, priceSource: record.price.source, dividendUpdatedAt: snapshot.generatedAt, dividendRate: record.dividend_rate.rate, dividendRateDate: record.dividend_rate.data_date, dividendRateKind: record.dividend_rate.kind, dividendRateYieldType: record.dividend_rate.yield_type, dividendCoverage: "complete" };
  }),
  transactions: [
    ...tickers.map((ticker, i) => ({ id: `buy-${ticker}`, assetId: ticker, type: "buy", date: "2026-01-02", shares: shares[i], price: [50, 49, 55, 27][i] })),
    ...[6, 7, 8, 9].flatMap(month => [0, 1].map(i => ({ id: `received-${month}-${i}`, assetId: tickers[i], type: "dividend", status: "received", date: `2026-${String(month).padStart(2, "0")}-20`, grossDividend: [38, 22][i], taxAndFees: [9.5, 5.5][i], netDividend: [28.5, 16.5][i], shareCount: shares[i] }))),
    { id: "tiny-qndx", assetId: "QNDX", type: "dividend", status: "announced", date: "2026-10-14", paymentDate: "2026-10-14", exDate: "2026-10-01", grossDividend: .544, taxAndFees: .16, netDividend: .384, perShare: .0272, shareCount: 20 },
    { id: "tiny-schd", assetId: "SCHD", type: "dividend", status: "announced", date: "2026-10-14", paymentDate: "2026-10-14", exDate: "2026-10-01", grossDividend: .2665, taxAndFees: .08, netDividend: .1865, perShare: .2665, shareCount: 1 },
  ],
};
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const relative = path === "/" ? "index.html" : path.slice(1);
    const target = resolve(root, relative);
    if (!target.startsWith(`${root}/`)) { res.writeHead(403); res.end(); return; }
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" }[extname(target)];
    res.writeHead(200, { "Content-Type": `${mime || "application/octet-stream"}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(await readFile(target));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
await mkdir(output, { recursive: true });
const base = `http://127.0.0.1:${server.address().port}`;
const report = { baseline, fixture: "illustrative holdings + committed public snapshot", snapshot: snapshot.generatedAt, engines: [] };

async function captureMoney(page) {
  return page.locator("[data-count-key]").evaluateAll(nodes => Object.fromEntries(nodes.filter(n => ["monthly-income", "received-income", "annual-forecast", "chart-total", "year-received"].includes(n.dataset.countKey)).map(n => [n.dataset.countKey, { value: Number(n.dataset.countValue), currency: n.dataset.countCurrency }])));
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const caption = rect(document.querySelector(".market-caption"));
    const dock = rect(document.querySelector(".navigation-dock"));
    const chart = rect(document.querySelector(".chart-card"));
    return { viewport: { width: innerWidth, height: innerHeight }, scrollHeight: document.documentElement.scrollHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, caption, dock, chart, oneScreen: caption.bottom + 8 <= dock.top && document.documentElement.scrollHeight <= innerHeight + 1 };
  });
}
async function settle(page) {
  await page.waitForTimeout(450);
  await page.evaluate(() => scrollTo(0, 0));
}
async function validatePage(page, tab, profile) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${profile}/${tab} horizontal overflow`);
  if (baseline) return;
  assert.equal(await page.locator(".settings-about").count(), 0);
  const clipped = await page.locator(".hero-value, .income-facts strong, .summary-item strong, .asset-stat-grid strong, .settings-menu-row small").evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 2).map(n => n.textContent));
  assert.deepEqual(clipped, [], `${profile}/${tab} clipped amounts`);
  assert.ok(await page.locator(".nav-btn, .topbar .icon-btn").evaluateAll(nodes => nodes.every(n => { const r = n.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; })), `${profile} undersized primary tap target`);
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const lastClear = await page.evaluate(() => {
    const selector = document.querySelector(".portfolio-page") ? ".portfolio-list > :last-child" : document.querySelector(".calendar-page") ? ".calendar-events-panel" : document.querySelector(".settings-page") ? ".settings-menu:last-of-type" : ".market-caption";
    return document.querySelector(selector).getBoundingClientRect().bottom + 8 <= document.querySelector(".navigation-dock").getBoundingClientRect().top;
  });
  assert.ok(lastClear, `${profile}/${tab} content covered by navigation`);
  await page.evaluate(() => scrollTo(0, 0));
}

for (const engine of ["Chromium", "WebKit"]) {
  if (process.env.MOBILE_ENGINE && engine !== process.env.MOBILE_ENGINE) continue;
  let browser;
  try {
    browser = await (engine === "Chromium" ? chromium : webkit).launch({ headless: true });
    const result = { engine, profiles: [], money: {} };
    report.engines.push(result);
    // CSS layout viewports, not physical screenshot pixels. The 440x956 profile
    // matches Playwright's iPhone 17 Pro Max device screen. Toolbar-reduced and safe
    // areas are tested separately; they are simulations, not an on-device claim.
    for (const profile of [
      { name: "iphone17promax-safari", width: 440, height: 763 },
      { name: "iphone17promax-pwa", width: 440, height: 956, safeTop: 62, safeBottom: 34 },
      { name: "iphone375", width: 375, height: 667 },
      { name: "iphone390", width: 390, height: 744 },
      { name: "iphone402", width: 402, height: 774 },
      { name: "iphone430", width: 430, height: 832 },
      { name: "large-text", width: 440, height: 763, fontSize: 24 },
    ]) {
      const context = await browser.newContext({ viewport: { width: profile.width, height: profile.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
      await context.addInitScript(({data, clock}) => {
        const NativeDate = Date;
        window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return new NativeDate(clock).getTime(); } };
        if (!sessionStorage.getItem("seeded")) { localStorage.setItem("tangping-dividend.v1", JSON.stringify(data)); sessionStorage.setItem("seeded", "1"); }
      }, {data:fixture, clock:snapshot.generatedAt});
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(base);
        await page.waitForFunction(price => JSON.parse(localStorage.getItem("tangping-dividend.v1")).assets[0].currentPrice === price, snapshot.symbols.QQQI.price.price);
        if (profile.safeTop) await page.addStyleTag({ content: `.app-shell{padding-top:calc(${profile.safeTop}px + 12px);padding-bottom:calc(${profile.safeBottom}px + var(--dock-content-reserve))}.navigation-dock{bottom:${profile.safeBottom + 10}px}` });
        if (profile.fontSize) await page.addStyleTag({ content: `html{font-size:${profile.fontSize}px}` });
        await settle(page);
        const layout = await geometry(page);
        result.profiles.push({ name: profile.name, ...layout });
        if (profile.name.startsWith("iphone17promax")) {
          await page.screenshot({ path: `${output}/${engine.toLowerCase()}-${profile.name}-home.png`, fullPage: baseline });
        }
        if (!baseline && profile.name.startsWith("iphone17promax")) assert.ok(layout.oneScreen, `${engine}/${profile.name} home does not fit one screen: ${JSON.stringify(layout)}`);
        if (profile.name === "iphone17promax-safari") {
          result.money.CNY = await captureMoney(page);
          result.chart = await page.locator("[data-chart-month]").evaluateAll(nodes => nodes.map(n => Number(n.dataset.chartTotal)));
          await page.locator('[data-action="toggle-currency"]').click();
          result.money.USD = await captureMoney(page);
          await page.locator('[data-action="toggle-currency"]').click();
        }
        for (const tab of ["home", "portfolio", "calendar", "settings"]) {
          await page.locator(`[data-tab="${tab}"]`).click();
          await settle(page);
          if (tab === "calendar") await page.locator('[data-date="2026-10-14"]').click();
          await validatePage(page, tab, `${engine}/${profile.name}`);
          if (tab === "portfolio") {
            const layout = await page.evaluate(() => {
              const cards = [...document.querySelectorAll(".asset-card-compact")].map(n => ({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom,height:n.getBoundingClientRect().height}));
              const dockTop = document.querySelector(".navigation-dock").getBoundingClientRect().top;
              return {cards,dockTop,oneScreen:cards.length===4 && cards[3].bottom+8<=dockTop && document.documentElement.scrollHeight<=innerHeight+1};
            });
            result.profiles.at(-1).portfolio = layout;
            assert.equal(await page.locator('.asset-toggle[aria-expanded="false"]').count(),4);
            if(profile.name.startsWith("iphone17promax")) assert.ok(layout.oneScreen,`${engine}/${profile.name} portfolio does not fit: ${JSON.stringify(layout)}`);
            await page.locator('.asset-toggle').first().click();
            assert.equal(await page.locator('.asset-toggle').first().getAttribute('aria-expanded'),'true');
            assert.ok(await page.locator('.asset-expanded').first().isVisible());
            assert.ok(await page.locator('[data-action="asset-detail"]').first().isVisible());
            await page.locator('.asset-toggle').first().click();
            assert.equal(await page.locator('.asset-toggle').first().getAttribute('aria-expanded'),'false');
          }
          if (profile.name === "iphone17promax-safari" || (tab === "home" && profile.name === "iphone17promax-pwa")) await page.screenshot({ path: `${output}/${engine.toLowerCase()}-${profile.name}-${tab}.png`, fullPage: tab === "portfolio" || baseline });
          if (profile.name === "iphone17promax-safari") {
            await page.emulateMedia({ colorScheme: "dark" });
            await settle(page);
            await validatePage(page, tab, `${engine}/dark/${tab}`);
            await page.screenshot({ path: `${output}/${engine.toLowerCase()}-dark-${tab}.png`, fullPage: tab === "portfolio" });
            await page.emulateMedia({ colorScheme: "light" });
          }
        }
        await page.reload();
        await page.waitForSelector(".income-hero");
        const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem("tangping-dividend.v1")));
        for (const tx of fixture.transactions) assert.deepEqual(ledger.transactions.find(item => item.id === tx.id), tx);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    console.log(`PASS ${engine}: seven layout profiles, four tabs, dark/light, full amounts, safe-area simulation, tap sizes, ledger persistence`);
  } catch (error) {
    if (engine === "WebKit" && !process.env.REQUIRE_WEBKIT && !browser) { console.log(`SKIP WebKit host unavailable: ${error.message.split("\n")[0]}`); continue; }
    throw error;
  } finally { if (browser) await browser.close(); }
}
await writeFile(`${output}/layout-report.json`, JSON.stringify(report, null, 2));
await new Promise(done => server.close(done));
console.log(`Saved ${output}/layout-report.json`);
