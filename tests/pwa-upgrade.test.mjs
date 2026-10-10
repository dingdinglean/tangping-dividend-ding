import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { APP_CACHE, APP_VERSION, SNAPSHOT_CACHE, USER_DATA_KEYS } from "../pwa-release.js";

// Cache names that have shipped. Activation of the current worker must drop
// these shells and must not touch localStorage.
const PREVIOUS_APP_CACHES = [
  "tangping-dividend-v1", // sw.js in 5767b94
  "tangping-dividend-v7.1", // docs/PR-V7.md
  "tangping-dividend-v7.3", // docs/TESTING-V7.md; not the same name as v7.3.0
  "tangping-dividend-v8.2", // main immediately before this branch
];

const listeners = new Map();
globalThis.self = {
  addEventListener(type, fn) { listeners.set(type, fn); },
  skipWaiting() {},
  clients: { claim: async () => {} },
  location: new URL("https://dingdinglean.github.io/tangping-dividend-ding/sw.js"),
};
globalThis.caches = {
  async keys() { return []; },
  async delete() { return false; },
  async open() { return { async addAll() {}, async put() {}, async match() { return undefined; } }; },
};
await import("../sw.js");

const appSource = (await readFile(new URL("../app.js", import.meta.url), "utf8")).replace(/^(?:import[^\r\n]*\r?\n)+/, "").split('if ("serviceWorker" in navigator)')[0];

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ["2026-09-05T12:00:00Z"])); }
  static now() { return new Date("2026-09-05T12:00:00Z").getTime(); }
}

async function activate(cacheNames) {
  const bodies = new Map(cacheNames.map((name) => [name, `body:${name}`]));
  const deleted = [];
  let storageTouches = 0;
  globalThis.caches = {
    async keys() { return [...bodies.keys()]; },
    async delete(name) { deleted.push(name); return bodies.delete(name); },
    async open(name) {
      if (!bodies.has(name)) bodies.set(name, `body:${name}`);
      return { async addAll() {}, async put() {}, async match() { return undefined; } };
    },
  };
  globalThis.localStorage = new Proxy({}, {
    get() {
      storageTouches += 1;
      throw new Error("service worker activate touched localStorage");
    },
  });
  let task;
  listeners.get("activate")({ waitUntil(promise) { task = promise; } });
  await task;
  delete globalThis.localStorage;
  return { deleted, remaining: [...bodies.keys()], storageTouches };
}

function boot(storage) {
  const context = vm.createContext({
    Date: FixedDate, crypto: webcrypto, structuredClone, Intl, URL, APP_VERSION,
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    },
    navigator: { onLine: true },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document: { visibilityState: "visible", documentElement: { dataset: {}, style: {} }, querySelector: () => null },
    setTimeout, clearTimeout, console,
    latestCompletedUsTradingSession: () => ({ date: "2026-09-04" }),
    configureMarketEndpoint() {},
    wait: async () => {},
  });
  vm.runInContext(appSource, context);
  vm.runInContext("render = () => {}; showToast = () => {};", context);
  return (code) => vm.runInContext(code, context);
}

function cacheSet() {
  return [...PREVIOUS_APP_CACHES, APP_CACHE, SNAPSHOT_CACHE, ...USER_DATA_KEYS, "other-site-cache"];
}

const v82Ledger = {
  version: 1,
  settings: {
    displayCurrency: "CNY",
    theme: "dark",
    exchangeRate: 7.25,
    monthlyGoal: 1800,
    alphaVantageApiKey: "TEST-ONLY",
    marketDataEndpoint: "https://example.com/api/market",
    marketDataMode: "snapshot",
    autoRefresh: true,
    customSetting: "keep",
    lastBackupAt: "2026-08-01T00:00:00.000Z",
    freedomMilestones: [
      { id: "milk-tea", icon: "☕", name: "奶茶自由", amountCny: 150 },
      { id: "utilities", icon: "⚡", name: "水电自由", amountCny: 400 },
      { id: "meals", icon: "🍽", name: "三餐自由", amountCny: 2500 },
      { id: "semi-retired", icon: "🌴", name: "半步退休", amountCny: 6000 },
      { id: "journey", icon: "🏔", name: "诗和远方", amountCny: 12000 },
      { id: "life", icon: "✨", name: "人生自由", amountCny: 20000 },
    ],
  },
  assets: [{ id: "schd", ticker: "SCHD", frequency: "quarterly", currentPrice: 28, manualDividendYieldPercent: 3.5, remoteDividends: [] }],
  transactions: [
    { id: "buy-v82", assetId: "schd", type: "buy", date: "2026-01-02", shares: 12, price: 27.5 },
    { id: "div-v82", assetId: "schd", type: "dividend", status: "received", date: "2026-06-24", netDividend: 49.63 },
  ],
};

const backupRecord = {
  createdAt: "2026-08-02T00:00:00.000Z",
  deletedAssetId: "old",
  state: { version: 1, transactions: [{ id: "deleted-trade", shares: 4 }] },
};

test("service worker activation deletes every previously shipped app cache and does not open localStorage", async () => {
  assert.equal(APP_CACHE, `tangping-dividend-v${APP_VERSION}`);
  assert.notEqual(APP_CACHE, "tangping-dividend-v7.3");
  const storage = new Map([
    [USER_DATA_KEYS[0], JSON.stringify(v82Ledger)],
    [USER_DATA_KEYS[1], JSON.stringify(backupRecord)],
  ]);
  const before = structuredClone([...storage]);
  const result = await activate(cacheSet());
  assert.equal(result.storageTouches, 0);
  assert.deepEqual([...storage], before);
  assert.deepEqual(result.deleted, PREVIOUS_APP_CACHES);
  assert.ok(result.remaining.includes(APP_CACHE));
  assert.ok(result.remaining.includes(SNAPSHOT_CACHE));
  assert.equal(result.remaining.includes("tangping-dividend-v7.3"), false);
  assert.equal(result.remaining.includes("tangping-dividend-v8.2"), false);
  for (const key of USER_DATA_KEYS) assert.ok(result.remaining.includes(key));
  assert.ok(result.remaining.includes("other-site-cache"));
});

test("v8.2 ledger and delete-backup survive activation and the following app boot", async () => {
  const storage = new Map([
    [USER_DATA_KEYS[0], JSON.stringify(v82Ledger)],
    [USER_DATA_KEYS[1], JSON.stringify(backupRecord)],
  ]);
  const backupBefore = storage.get(USER_DATA_KEYS[1]);
  const result = await activate(["tangping-dividend-v8.2", APP_CACHE, SNAPSHOT_CACHE]);
  assert.equal(result.storageTouches, 0);
  assert.deepEqual(result.deleted, ["tangping-dividend-v8.2"]);
  assert.equal(storage.get(USER_DATA_KEYS[0]), JSON.stringify(v82Ledger));
  assert.equal(storage.get(USER_DATA_KEYS[1]), backupBefore);
  const run = boot(storage);
  assert.equal(run("stateNeedsMigration"), false);
  run("if (stateNeedsMigration) saveState()");
  const stored = JSON.parse(storage.get(USER_DATA_KEYS[0]));
  assert.equal(stored.transactions[0].id, "buy-v82");
  assert.equal(stored.transactions[0].shares, 12);
  assert.equal(stored.transactions[1].netDividend, 49.63);
  assert.equal(stored.settings.alphaVantageApiKey, "TEST-ONLY");
  assert.equal(stored.settings.marketDataEndpoint, "https://example.com/api/market");
  assert.equal(stored.settings.exchangeRate, 7.25);
  assert.equal(stored.settings.theme, "dark");
  assert.equal(stored.settings.customSetting, "keep");
  assert.equal(stored.assets[0].ticker, "SCHD");
  assert.equal(storage.get(USER_DATA_KEYS[1]), backupBefore);
});

test("v7.3 direct-mode settings and v1 trades survive activation, then app migration", async () => {
  const v73 = {
    version: 1,
    settings: {
      displayCurrency: "USD",
      exchangeRate: 7.11,
      monthlyGoal: 2000,
      marketDataMode: "direct",
      alphaVantageApiKey: "TEST-ONLY",
      marketDataEndpoint: "https://example.com/api/market",
      autoRefresh: false,
      customSetting: "from-v7.3",
    },
    assets: [{ id: "qqqi", ticker: "QQQI", frequency: "monthly", currentPrice: 50 }],
    transactions: [{ id: "buy-v73", assetId: "qqqi", type: "buy", date: "2025-11-03", shares: 8, price: 49 }],
  };
  const v1 = {
    version: 1,
    settings: { displayCurrency: "CNY", exchangeRate: 7.2, monthlyGoal: 1000, lastBackupAt: "2024-05-01T00:00:00.000Z" },
    assets: [{ id: "a", ticker: "SCHD", frequency: "quarterly", currentPrice: 28 }],
    transactions: [{ id: "buy-v1", assetId: "a", type: "buy", date: "2024-01-02", shares: 3, price: 25 }],
  };
  for (const [cacheName, saved] of [["tangping-dividend-v7.3", v73], ["tangping-dividend-v1", v1]]) {
    const storage = new Map([
      [USER_DATA_KEYS[0], JSON.stringify(saved)],
      [USER_DATA_KEYS[1], JSON.stringify(backupRecord)],
    ]);
    const backupBefore = storage.get(USER_DATA_KEYS[1]);
    const result = await activate([cacheName, "tangping-dividend-v7.1", SNAPSHOT_CACHE]);
    assert.equal(result.storageTouches, 0, cacheName);
    assert.equal(storage.get(USER_DATA_KEYS[0]), JSON.stringify(saved));
    assert.equal(storage.get(USER_DATA_KEYS[1]), backupBefore);
    const run = boot(storage);
    assert.equal(run("stateNeedsMigration"), true);
    run("if (stateNeedsMigration) saveState()");
    const stored = JSON.parse(storage.get(USER_DATA_KEYS[0]));
    assert.equal(stored.transactions[0].id, saved.transactions[0].id);
    assert.equal(stored.transactions[0].shares, saved.transactions[0].shares);
    assert.equal(stored.assets[0].ticker, saved.assets[0].ticker);
    assert.equal(stored.settings.exchangeRate, saved.settings.exchangeRate);
    assert.equal(stored.settings.displayCurrency, saved.settings.displayCurrency);
    assert.equal(stored.settings.monthlyGoal, saved.settings.monthlyGoal);
    if (saved.settings.alphaVantageApiKey) {
      assert.equal(stored.settings.alphaVantageApiKey, "TEST-ONLY");
      assert.equal(stored.settings.marketDataEndpoint, saved.settings.marketDataEndpoint);
      assert.equal(stored.settings.customSetting, "from-v7.3");
    }
    assert.equal(stored.settings.lastBackupAt ?? null, saved.settings.lastBackupAt ?? null);
    assert.equal(storage.get(USER_DATA_KEYS[1]), backupBefore);
    assert.equal(result.remaining.includes(SNAPSHOT_CACHE), true);
    assert.equal(result.remaining.includes(cacheName), false);
  }
});

test("unreadable localStorage is still unreadable after activation", async () => {
  const storage = new Map([
    [USER_DATA_KEYS[0], "{broken-json"],
    [USER_DATA_KEYS[1], "{\"marker\":\"keep-backup\"}"],
  ]);
  const result = await activate(["tangping-dividend-v8.2", APP_CACHE]);
  assert.equal(result.storageTouches, 0);
  assert.equal(storage.get(USER_DATA_KEYS[0]), "{broken-json");
  assert.equal(storage.get(USER_DATA_KEYS[1]), "{\"marker\":\"keep-backup\"}");
  const run = boot(storage);
  assert.equal(run("storageReadError"), true);
  assert.throws(() => run("saveState()"), /停止写入/);
  assert.equal(storage.get(USER_DATA_KEYS[0]), "{broken-json");
  assert.equal(storage.get(USER_DATA_KEYS[1]), "{\"marker\":\"keep-backup\"}");
});
