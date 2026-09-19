import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createMarketService, createServer } from "../server/server.mjs";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = createServer(await createMarketService());
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base=`http://127.0.0.1:${server.address().port}`;
// Synthetic fixtures in disposable browser contexts. Never touch a personal profile.
const fixture={version:1,settings:{displayCurrency:"CNY",exchangeRate:7,autoRefresh:false,alphaVantageApiKey:"TEST-ONLY"},
 assets:[{id:"demo",ticker:"DEMO",name:"测试专用 · 月度股息 ETF",frequency:"monthly",type:"ETF",role:"测试数据",currentPrice:100,manualDividendYieldPercent:12,remoteDividends:[]}],
 transactions:[{id:"buy",assetId:"demo",type:"buy",date:"2026-01-01",shares:100,price:90},
 ...[4,5,6,7,8].map(m=>({id:`d${m}`,assetId:"demo",type:"dividend",status:"received",date:`2026-${String(m).padStart(2,"0")}-01`,netDividend:m*10,shareCount:100}))]};

async function testStaticSnapshots(browser, engine) {
  let price=101;let requests=0;let fail=false;
  const sessionDate="2026-09-18";
  const snapshotServer=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);
    if(url.pathname==="/data/market.json") {
      requests++;res.writeHead(fail?503:200,{"Content-Type":"application/json","Cache-Control":"no-store"});
      res.end(JSON.stringify({schemaVersion:2,generatedAt:new Date().toISOString(),fx:{rate:7,fx_date:sessionDate,source:"test",fetched_at:new Date().toISOString()},symbols:{QQQI:{
        price:{symbol:"QQQI",price,price_date:sessionDate,source:"test",fetched_at:new Date().toISOString()},price_status:"valid",expected_price_date:sessionDate,
        dividends:{data:[{ex_date:sessionDate,payment_date:sessionDate,amount:1}],source:"test",fetched_at:new Date().toISOString()},
        dividend_rate:{rate:.12,data_date:sessionDate,source:"test",kind:"distribution_rate"},
      }}}));return;
    }
    const upstream=await fetch(base+url.pathname+url.search);res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(r=>snapshotServer.listen(0,"127.0.0.1",r));
  const context=await browser.newContext({viewport:{width:390,height:844}});
  try {
    await context.route("https://api.frankfurter.dev/**",r=>r.fulfill({json:{rate:7,date:"2026-09-05"}}));
    const page=await context.newPage();const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${snapshotServer.address().port}`);
    await page.evaluate(()=>localStorage.setItem("tangping-dividend.v1",JSON.stringify({version:1,settings:{autoRefresh:true},assets:[{id:"test",ticker:"QQQI",frequency:"monthly",currentPrice:0}],transactions:[]})));
    await page.reload();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).settings.alphaVantageApiKey),"");
    const snapshotPrice=()=>page.evaluate(async()=>{const response=await fetch("./data/market.json",{cache:"no-store"});return (await response.json()).symbols.QQQI.price.price;});
    assert.equal(await snapshotPrice(),101);
    price=105;
    assert.equal(await snapshotPrice(),105);
    assert.ok(requests>=2);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.reload();
    assert.equal(await snapshotPrice(),105);
    const snapshotCachePrice=()=>page.evaluate(async()=>{const cache=await caches.open("tangping-market-snapshots-v2");const response=await cache.match(new URL("./data/market.json",location.href).href);return (await response.json()).symbols.QQQI.price.price;});
    await context.setOffline(true);
    const cached=await snapshotCachePrice();
    assert.equal(cached,105);
    await context.setOffline(false);fail=true;
    assert.equal(await snapshotCachePrice(),105);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${engine} snapshot: no personal key, new network snapshot, offline/503 last-good fallback`);
  } finally {await context.close();await new Promise(r=>snapshotServer.close(r));}
}
let browser;
try {
  browser=await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const page=await context.newPage(); const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(base);
  await page.evaluate(data=>localStorage.setItem("tangping-dividend.v1",JSON.stringify(data)),fixture);
  await page.reload(); await page.waitForSelector(".chart-bars");
  assert.equal(await page.locator(".bar-group").count(),12);
  assert.ok(await page.locator(".bar.received").evaluateAll(bars=>bars.some(el=>el.getBoundingClientRect().height>10)));
  assert.equal(await page.locator(".milestone").count(),0);
  assert.equal(await page.locator(".milestone-details").count(),0);
  assert.equal(await page.locator(".sync-bar").count(),0);
  assert.equal(await page.locator(".bottom-nav .nav-btn").count(),4);
  assert.equal(await page.locator(".add-btn").count(),0);
  assert.ok(await page.locator(".floating-add").isVisible());
  assert.ok(await page.evaluate(()=>{const fab=document.querySelector(".floating-add").getBoundingClientRect();const nav=document.querySelector(".bottom-nav").getBoundingClientRect();const separate=fab.right<=nav.left||fab.left>=nav.right||fab.bottom<=nav.top||fab.top>=nav.bottom;return fab.bottom<=innerHeight&&fab.right<=innerWidth&&separate;}));
  await page.locator(".floating-add").click();
  assert.ok(await page.locator("#transactionForm").isVisible());
  await page.locator('[data-action="close-modal"]').last().click();
  for(const width of [390,430,1280]) {
    await page.setViewportSize({width,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`home overflow at ${width}`);
    assert.ok(await page.evaluate(()=>{const head=document.querySelector('.topbar').getBoundingClientRect(),nav=document.querySelector('.bottom-nav').getBoundingClientRect();return head.top>=0&&head.bottom<nav.top;}),`home fixed header at ${width}`);
  }
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({colorScheme:"dark"});
  await page.emulateMedia({colorScheme:"light"});
  await page.locator('[data-tab="portfolio"]').click();
  assert.equal(await page.locator('[data-action="delete-asset"]').count(),0);
  assert.ok(await page.locator(".asset-card-compact").isVisible());
  assert.ok(await page.locator(".floating-add").isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await page.evaluate(()=>{const head=document.querySelector('.topbar').getBoundingClientRect(),nav=document.querySelector('.bottom-nav').getBoundingClientRect();return head.top>=0&&head.bottom<nav.top;}));
  await page.locator(".asset-card-compact").click();
  assert.ok(await page.locator(".asset-detail-summary").isVisible());
  assert.ok(await page.locator('[data-action="delete-asset"]').isVisible());
  await page.locator('[data-action="close-modal"]').last().click();
  await page.locator('[data-tab="calendar"]').click();
  assert.ok(await page.locator(".calendar-month,.calendar-events-panel").count()===2);
  assert.ok(await page.evaluate(()=>{const head=document.querySelector('.topbar').getBoundingClientRect(),nav=document.querySelector('.bottom-nav').getBoundingClientRect();return head.top>=0&&head.bottom<nav.top;}));
  await page.locator('[data-action="next-month"]').click();
  await page.locator(".day").nth(10).click();
  assert.ok(await page.locator(".calendar-events-scroll").isVisible());
  await page.locator('[data-tab="settings"]').click();
  assert.equal(await page.locator(".floating-add").count(),0);
  assert.equal(await page.locator("#marketDataMode,#marketDataEndpoint,#alphaVantageApiKey,#autoRefresh").count(),0);
  assert.equal(await page.getByText("动态数据").count(),0);
  assert.ok(await page.getByText("躺平股息", { exact: true }).isVisible());
  assert.equal(await page.locator(".settings-menu-row").count(),7);
  assert.ok(await page.evaluate(()=>{const head=document.querySelector('.topbar').getBoundingClientRect(),nav=document.querySelector('.bottom-nav').getBoundingClientRect();return head.top>=0&&head.bottom<nav.top;}));
  await page.locator('[data-action="open-milestone-settings"]').click();
  assert.ok(await page.locator("#milestoneSettingsForm").isVisible());
  await page.locator('[data-milestone-field="name"]').first().fill("咖啡自由");
  await page.locator("#milestoneSettingsForm [type=submit]").click();
  await page.reload();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).settings.freedomMilestones[0].name),"咖啡自由");
  for(const width of [390,430]) {
    await page.setViewportSize({width,height:844});
    for(const tab of ["home","portfolio","calendar","settings"]) {
      await page.locator(`[data-tab="${tab}"]`).click();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab} horizontal overflow at ${width}`);
      assert.ok(await page.evaluate(()=>{const head=document.querySelector('.topbar').getBoundingClientRect(),nav=document.querySelector('.bottom-nav').getBoundingClientRect();return head.top>=0&&head.bottom<nav.top&&nav.bottom<=innerHeight;}),`${tab} fixed chrome at ${width}`);
    }
  }
  assert.deepEqual(errors,[]);
  console.log("PASS Chromium: mobile home/portfolio/calendar/settings, sheets, appearance, and no page errors");
  await context.close();
  // Upgrade a controlled v6 cache to v7 and count real page navigations.
  let legacy=true;
  const sw=await readFile(new URL("../sw.js",import.meta.url),"utf8");
  const upgradeServer=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);
    if(url.pathname==="/sw.js") {res.writeHead(200,{"Content-Type":"text/javascript","Cache-Control":"no-store"});res.end(legacy?sw.replaceAll("v8.2","v8.1"):sw);return;}
    const upstream=await fetch(base+url.pathname+url.search);res.writeHead(upstream.status,Object.fromEntries(upstream.headers));res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise(r=>upgradeServer.listen(0,"127.0.0.1",r));
  const updateContext=await browser.newContext();
  try {
    const updatePage=await updateContext.newPage();
    await updatePage.goto(`http://127.0.0.1:${upgradeServer.address().port}`);
    await updatePage.evaluate(()=>navigator.serviceWorker.ready);
    await updatePage.reload();
    await updatePage.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
    let navigations=0; updatePage.on("framenavigated",frame=>{if(frame===updatePage.mainFrame())navigations++;});
    legacy=false;
    await updatePage.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();});
    await updatePage.waitForFunction(()=>sessionStorage.getItem("tangping-dividend.reloaded-v8.2")==="1");
    await updatePage.waitForSelector(".app-shell");
    assert.equal(navigations,1);
    assert.ok((await updatePage.evaluate(()=>caches.keys())).includes("tangping-dividend-v8.2"));
    console.log("PASS PWA upgrade: v8.1 cache -> v8.2, exactly one automatic reload");
  } finally {await updateContext.close(); await new Promise(r=>upgradeServer.close(r));}
  await testStaticSnapshots(browser,"Chromium");
  await browser.close(); browser=null;
  try { browser=await webkit.launch({headless:true}); }
  catch(error) { if(process.env.REQUIRE_WEBKIT) throw error; console.log("SKIP WebKit: browser binary unavailable (not a real iPhone verification)"); }
  if(browser) {
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.goto(base); await page.evaluate(data=>localStorage.setItem("tangping-dividend.v1",JSON.stringify(data)),fixture); await page.reload();
    assert.ok(await page.locator(".bar.received").evaluateAll(bars=>bars.some(el=>el.getBoundingClientRect().height>10)));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    for(const tab of ["home","portfolio","calendar","settings"]) { await page.locator(`[data-tab="${tab}"]`).click(); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`WebKit horizontal overflow ${tab}`); }
    console.log("PASS WebKit: 390px tabs, nonzero chart bars and no horizontal overflow");
    await testStaticSnapshots(browser,"WebKit");
  }
} finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
