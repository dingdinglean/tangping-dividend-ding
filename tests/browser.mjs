import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createMarketService, createServer } from "../server/server.mjs";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = createServer(await createMarketService());
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const base=`http://127.0.0.1:${server.address().port}`;
await mkdir("docs/screenshots",{recursive:true});
// Synthetic fixtures in disposable browser contexts. Never touch a personal profile.
const fixture={version:1,settings:{displayCurrency:"CNY",exchangeRate:7,autoRefresh:false,alphaVantageApiKey:"TEST-ONLY"},
 assets:[{id:"demo",ticker:"DEMO",name:"测试专用 · 月度股息 ETF",frequency:"monthly",type:"ETF",role:"测试数据",currentPrice:100,manualDividendYieldPercent:12,remoteDividends:[]}],
 transactions:[{id:"buy",assetId:"demo",type:"buy",date:"2026-01-01",shares:100,price:90},
 ...[4,5,6,7,8].map(m=>({id:`d${m}`,assetId:"demo",type:"dividend",status:"received",date:`2026-${String(m).padStart(2,"0")}-01`,netDividend:m*10,shareCount:100}))]};

async function testStaticSnapshots(browser, engine) {
  let price=101;let requests=0;let fail=false;
  const snapshotServer=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);
    if(url.pathname==="/data/market.json") {
      requests++;res.writeHead(fail?503:200,{"Content-Type":"application/json","Cache-Control":"no-store"});
      res.end(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),symbols:{QQQI:{
        GLOBAL_QUOTE:{"Global Quote":{"05. price":price},_fetchedAt:new Date().toISOString(),_status:"ok"},
        DIVIDENDS:{data:[{ex_dividend_date:"2026-09-01",payment_date:"2026-09-10",amount:1}],_fetchedAt:new Date().toISOString(),_status:"ok"},
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
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).assets[0].currentPrice===101);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).settings.alphaVantageApiKey),"");
    price=105;await page.reload();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).assets[0].currentPrice===105);
    assert.ok(requests>=2);
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await context.setOffline(true);
    // Windows WebKit reports an internal error for offline top-level navigation.
    // Still test an actual uncached module request through its service worker.
    if(engine==="Chromium") await page.reload();
    const cached=await page.evaluate(async()=>{const data=await import("./market-data.js?v=7.2");data.configureMarketEndpoint("");data.configureMarketEndpoint("./data/market.json");return (await data.fetchAlphaQuote("QQQI")).price;});
    assert.equal(cached,105);
    await context.setOffline(false);fail=true;await page.reload();
    assert.equal(await page.evaluate(async()=>{const data=await import("./market-data.js?v=7.2");data.configureMarketEndpoint("./data/market.json");return (await data.fetchAlphaQuote("QQQI")).price;}),105);
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
  assert.ok(await page.evaluate(()=>{const fab=document.querySelector(".floating-add").getBoundingClientRect();const nav=document.querySelector(".bottom-nav").getBoundingClientRect();return fab.bottom <= nav.top + 1;}));
  await page.locator(".floating-add").click();
  assert.ok(await page.locator("#transactionForm").isVisible());
  await page.locator('[data-action="close-modal"]').last().click();
  for(const width of [390,430,1280]) {
    await page.setViewportSize({width,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`home overflow at ${width}`);
  }
  assert.ok(await page.evaluate(()=>document.querySelector(".chart-card").getBoundingClientRect().bottom < innerHeight * 1.5),"home core exceeds 1.5 screens");
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:"docs/screenshots/home-mobile-v7.png",fullPage:true});
  await page.locator(".chart-card").evaluate(el=>el.scrollIntoView({block:"start"}));
  await page.locator(".chart-card").screenshot({path:"docs/screenshots/chart-mobile-v7.png"});
  await page.evaluate(()=>scrollTo(0,0));
  await page.emulateMedia({colorScheme:"dark"});
  await page.screenshot({path:"docs/screenshots/home-dark-v7.png",fullPage:true});
  await page.emulateMedia({colorScheme:"light"});
  await page.locator('[data-tab="portfolio"]').click();
  assert.ok(await page.locator('[data-action="delete-asset"]').isVisible());
  assert.ok(await page.locator(".floating-add").isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:"docs/screenshots/portfolio-mobile-v7.png",fullPage:true});
  await page.locator('[data-action="open-asset"]').click();
  await page.locator('[name="ticker"]').fill("EMPTY");
  await page.locator('[name="name"]').fill("测试空标的");
  await page.locator('#assetForm [type="submit"]').click();
  assert.equal(await page.locator(".asset-card").count(),2);
  page.once("dialog",d=>d.accept());
  await page.locator('.asset-card').filter({hasText:"测试空标的"}).locator('[data-action="delete-asset"]').click();
  assert.equal(await page.locator(".asset-card").count(),1);
  page.once("dialog",d=>d.dismiss()); await page.locator('[data-action="delete-asset"]').click();
  assert.equal(await page.locator(".asset-card").count(),1);
  page.once("dialog",async d=>{assert.match(d.message(),/股息 5 笔/);await d.accept();});
  await page.locator('[data-action="delete-asset"]').click();
  assert.equal(await page.locator(".asset-card").count(),0);
  const deleted=await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")));
  assert.equal(deleted.transactions.length,0);
  assert.ok(await page.evaluate(()=>Boolean(localStorage.getItem("tangping-dividend.backup-before-delete"))));
  await page.reload(); assert.equal((await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")))).assets.length,0);
  await page.locator('[data-tab="home"]').click();
  assert.ok(await page.getByText("暂无持仓").isVisible());
  assert.equal(await page.locator(".metric-card").count(),0);
  assert.ok(await page.getByText("添加第一笔持仓").isVisible());
  await page.locator('[data-tab="settings"]').click();
  assert.equal(await page.locator(".floating-add").count(),0);
  assert.equal(await page.locator("#marketDataMode,#marketDataEndpoint,#alphaVantageApiKey,#autoRefresh").count(),0);
  assert.equal(await page.getByText("动态数据").count(),0);
  assert.ok(await page.getByText("躺平股息 V7.2").isVisible());
  await page.locator('[data-milestone-field="name"]').first().fill("咖啡自由");
  await page.locator('[data-action="save-settings"]').click();
  await page.reload();
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("tangping-dividend.v1")).settings.freedomMilestones[0].name),"咖啡自由");
  await page.evaluate(()=>navigator.serviceWorker.ready);
  await context.setOffline(true); await page.reload(); await page.waitForSelector(".chart-bars");
  assert.ok((await page.evaluate(()=>caches.keys())).includes("tangping-dividend-v7.2"));
  await context.setOffline(false);
  assert.deepEqual(errors,[]);
  console.log("PASS Chromium: 390/430/1280 layout, light/dark screenshots, chart, CRUD, migration, settings persistence, offline cache, no page errors");
  await context.close();
  // Upgrade a controlled v6 cache to v7 and count real page navigations.
  let legacy=true;
  const sw=await readFile(new URL("../sw.js",import.meta.url),"utf8");
  const upgradeServer=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);
    if(url.pathname==="/sw.js") {res.writeHead(200,{"Content-Type":"text/javascript","Cache-Control":"no-store"});res.end(legacy?sw.replaceAll("v7.2","v7.1"):sw);return;}
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
    await updatePage.waitForFunction(()=>sessionStorage.getItem("tangping-dividend.reloaded-v7.2")==="1");
    await updatePage.waitForSelector(".chart-bars");
    assert.equal(navigations,1);
    assert.ok((await updatePage.evaluate(()=>caches.keys())).includes("tangping-dividend-v7.2"));
    console.log("PASS PWA upgrade: old cache -> v7.2, exactly one automatic reload");
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
    console.log("PASS WebKit: 390px nonzero chart bars and no overflow");
    await testStaticSnapshots(browser,"WebKit");
  }
} finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
