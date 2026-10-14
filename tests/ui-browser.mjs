import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createMarketService, createServer } from "../server/server.mjs";
import { APP_VERSION } from "../pwa-release.js";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = createServer(await createMarketService());
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const screenshots = process.env.UI_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
const fresh = "2026-10-13T03:12:09.822Z";
const fixture = {
  version: 1,
  settings: { displayCurrency: "CNY", exchangeRate: 7, exchangeRateUpdatedAt: fresh, autoRefresh: true, lastMarketRefreshAt: fresh },
  assets: [{ id: "qqqi", ticker: "QQQI", name: "NEOS Nasdaq-100 High Income ETF", type: "ETF", frequency: "monthly", currentPrice: 100, priceDate: "2026-10-12", priceUpdatedAt: fresh, priceSource: "test", dividendUpdatedAt: fresh, manualDividendYieldPercent: 12, remoteDividends: [] }],
  transactions: [
    { id: "buy", assetId: "qqqi", type: "buy", date: "2026-01-02", shares: 100, price: 90 },
    { id: "sep", assetId: "qqqi", type: "dividend", status: "received", date: "2026-09-02", grossDividend: 25, netDividend: 25, shareCount: 100 },
    { id: "oct", assetId: "qqqi", type: "dividend", status: "received", date: "2026-10-02", grossDividend: 40, netDividend: 40, shareCount: 100 },
    { id: "due-a", assetId: "qqqi", type: "dividend", status: "announced", date: "2026-10-10", paymentDate: "2026-10-10", exDate: "2026-10-01", grossDividend: 100, taxAndFees: 25, netDividend: 75, perShare: 1, shareCount: 100 },
    { id: "due-b", assetId: "qqqi", type: "dividend", status: "announced", date: "2026-10-11", paymentDate: "2026-10-11", exDate: "2026-10-03", grossDividend: 70, taxAndFees: 20, netDividend: 50, perShare: .7, shareCount: 100 },
  ],
};
const cny = value => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(value);

async function contextFor(browser, data = fixture, options = {}) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Shanghai", ...options });
  await context.addInitScript(data => {
    const NativeDate = Date;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : ["2026-10-13T03:30:00Z"])); }
      static now() { return new NativeDate("2026-10-13T03:30:00Z").getTime(); }
    };
    if (!sessionStorage.getItem("ui-fixture-seeded")) {
      localStorage.setItem("tangping-dividend.v1", JSON.stringify(data));
      sessionStorage.setItem("ui-fixture-seeded", "1");
    }
  }, data);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.waitForSelector(".chart-bars");
  return { context, page, errors };
}

async function finishMotion(page) {
  await page.locator(".chart-card").evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
}

async function checkSelection(page, month, amount) {
  await page.locator(`[data-chart-month="${month - 1}"]`).tap();
  await finishMotion(page);
  assert.equal(await page.locator('.bar-group[aria-pressed="true"]').count(), 1);
  assert.equal(await page.locator(".chart-tooltip strong").innerText(), cny(amount));
  assert.equal(await page.locator(".chart-tooltip").getAttribute("aria-hidden"), "false");
  assert.ok(await page.evaluate(() => {
    const tip = document.querySelector(".chart-tooltip").getBoundingClientRect();
    const card = document.querySelector(".chart-card").getBoundingClientRect();
    const heading = document.querySelector(".chart-head").getBoundingClientRect();
    return tip.left >= card.left + 3 && tip.right <= card.right - 3 && tip.top >= heading.bottom && tip.bottom < card.bottom;
  }), `${month}月 tooltip clipped or overlapping its heading`);
}

async function confirmFirst(page) {
  let navigations = 0;
  const navigation = frame => { if (frame === page.mainFrame()) navigations += 1; };
  page.on("framenavigated", navigation);
  await page.locator('[data-action="open-dividend-inbox"]').click();
  assert.equal(await page.locator(".pending-dividend").count(), 2);
  await page.locator('[data-pending-id="due-a"] [data-action="confirm-dividend"]').click();
  assert.ok(await page.locator(".modal").evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1; }), "confirmation sheet exceeds the viewport");
  await page.locator('[name="actualDate"]').fill("2026-10-10");
  await page.locator('[name="grossDividend"]').fill("100.00");
  await page.locator('[name="taxAndFees"]').fill("30.00");
  assert.equal(await page.locator('[name="netDividend"]').inputValue(), "70.00");
  await page.locator("#confirmDividendForm [type=submit]").click();
  assert.equal(await page.locator(".receipt-success").innerText(), "✓ 已收到");
  assert.ok(await page.locator(".receipt-success").evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1; }), "success button jumps offscreen on a short phone");
  assert.equal(await page.locator(".bell-badge").innerText(), "1");
  assert.equal(navigations, 0, "receipt confirmation must not reload the page");
  page.off("framenavigated", navigation);
}

async function runUi(browser, engine) {
  const { context, page, errors } = await contextFor(browser);
  try {
    assert.equal(await page.locator(".modal").count(), 0, "launch must not open an inbox");
    assert.equal(await page.locator(".bell-badge").innerText(), "2");
    assert.equal(await page.locator(".chart-tooltip").getAttribute("aria-hidden"), "true");
    assert.equal(await page.locator(".chart-tooltip").innerText(), "");
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : width === 375 ? 667 : 844 });
      await finishMotion(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${engine} overflow at ${width}px`);
      assert.ok(await page.evaluate(() => {
        const hero = document.querySelector(".income-hero").getBoundingClientRect();
        const milestone = document.querySelector(".freedom-card").getBoundingClientRect();
        return milestone.top - hero.bottom >= 9 && document.querySelectorAll(".income-facts > div").length === 3 && !document.querySelector(".home-yield-grid");
      }), `${engine} three-region compact spacing at ${width}px`);
      assert.ok(await page.locator(".chart-grid-lines i span").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1)), `${engine} clipped chart axis at ${width}px`);
      await checkSelection(page, 1, 0);
      await checkSelection(page, 10, 1155);
      await checkSelection(page, 11, 700);
      await checkSelection(page, 12, 700);
      await page.locator(".chart-plot").click({ position: { x: 4, y: 8 } });
      await page.waitForFunction(() => !document.querySelector(".chart-tooltip").textContent);
      assert.equal(await page.locator('.bar-group[aria-pressed="true"]').count(), 0);
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await checkSelection(page, 10, 1155);
    if (screenshots) await page.screenshot({ path: `${screenshots}/${engine.toLowerCase()}-home-375.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await finishMotion(page);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()), "#000000");
    if (screenshots) await page.screenshot({ path: `${screenshots}/${engine.toLowerCase()}-home-dark-375.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator('[data-action="open-dividend-inbox"]').click();
    if (screenshots) await page.screenshot({ path: `${screenshots}/${engine.toLowerCase()}-inbox-375.png` });
    await page.locator('[aria-label="关闭待确认股息"]').click();
    await confirmFirst(page);
    await page.waitForSelector(".dividend-inbox");
    assert.equal(await page.locator(".pending-dividend").count(), 1);
    await page.locator('[aria-label="关闭待确认股息"]').click();
    await page.waitForFunction(() => document.querySelector('[data-count-key="received-income"]').textContent === "¥945.00");
    assert.equal(await page.locator('[data-count-key="year-received"]').innerText(), cny(945));
    assert.equal(await page.locator('[data-count-key="monthly-income"]').innerText(), cny(630));
    assert.equal(await page.locator('[data-count-key="annual-forecast"]').innerText(), cny(7560));
    assert.equal(await page.locator('[data-count-key="chart-total"]').innerText(), cny(2555));
    await checkSelection(page, 10, 1120);
    await checkSelection(page, 11, 630);
    assert.ok(await page.locator('.bar-group[data-chart-month="9"] .bar.received').evaluate(el => el.clientHeight > 0));
    await page.reload();
    await page.waitForSelector(".chart-bars");
    assert.equal(await page.locator(".bell-badge").innerText(), "1");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("tangping-dividend.v1")));
    assert.equal(saved.transactions.find(tx => tx.id === "due-a").status, "received");
    assert.equal(saved.transactions.find(tx => tx.id === "due-a").netDividend, 70);
    assert.equal(saved.transactions.find(tx => tx.id === "due-b").status, "announced");
    assert.equal(await page.locator(".chart-tooltip").getAttribute("aria-hidden"), "true");
    await page.locator('[data-chart-month="9"]').focus();
    await page.locator('[data-chart-month="9"]').press("Enter");
    assert.equal(await page.locator('.bar-group[aria-pressed="true"]').count(), 1);
    await page.locator('[data-chart-month="9"]').press("Escape");
    assert.equal(await page.locator('.bar-group[aria-pressed="true"]').count(), 0);
    for (const tab of ["portfolio", "calendar", "settings", "home"]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      assert.ok(await page.locator(".tab-page").evaluate(el => getComputedStyle(el).animationName === "page-enter"));
    }
    await page.evaluate(() => navigator.serviceWorker.ready);
    assert.ok(await page.evaluate(async version => (await caches.keys()).includes(`tangping-dividend-v${version}`), APP_VERSION));
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine}: 320/375/390/430px, Oct/Nov/Dec selection and blank dismissal, spacing, dark mode, inbox 2→1, actual receipt, all dashboard totals, reload persistence, tab motion and PWA cache`);
  } finally { await context.close(); }

  const reduced = await contextFor(browser, fixture, { reducedMotion: "reduce", viewport: { width: 320, height: 568 } });
  try {
    assert.equal(await reduced.page.locator(".bar-growth").first().evaluate(el => getComputedStyle(el).animationName), "none");
    await confirmFirst(reduced.page);
    assert.equal(await reduced.page.locator('[data-count-key="received-income"]').innerText(), cny(945));
    assert.equal(await reduced.page.locator(".chart-tooltip").evaluate(el => getComputedStyle(el).transitionDuration), "0s");
    assert.deepEqual(reduced.errors, []);
    console.log(`PASS ${engine}: prefers-reduced-motion, immediate final amounts and no chart animation`);
  } finally { await reduced.context.close(); }

  const old = structuredClone(fixture);
  old.assets[0].priceDate = "2026-10-09";
  const market = await contextFor(browser, old);
  try {
    const source = JSON.parse(await readFile(new URL("../data/market.json", import.meta.url), "utf8"));
    await market.page.waitForFunction(expected => JSON.parse(localStorage.getItem("tangping-dividend.v1")).assets[0].currentPrice === expected, source.symbols.QQQI.price.price);
    const saved = await market.page.evaluate(() => JSON.parse(localStorage.getItem("tangping-dividend.v1")));
    assert.equal(saved.assets[0].priceDate, source.symbols.QQQI.price.price_date);
    assert.equal(saved.assets[0].manualDividendYieldPercent, 12);
    assert.equal(saved.transactions.find(tx => tx.id === "oct").netDividend, 40);
    assert.deepEqual(market.errors, []);
    console.log(`PASS ${engine}: unchanged automatic snapshot path loads ${source.generatedAt} / close ${saved.assets[0].priceDate}, keeps holdings and confirmed receipts`);
  } finally { await market.context.close(); }
}

let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}) });
  await runUi(browser, "Chromium");
  await browser.close(); browser = null;
  try { browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE_PATH ? { executablePath: process.env.WEBKIT_EXECUTABLE_PATH } : {}) }); }
  catch (error) { if (process.env.REQUIRE_WEBKIT) throw error; console.log("SKIP WebKit: unavailable; this does not count as iPhone verification"); }
  if (browser) await runUi(browser, "WebKit");
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
