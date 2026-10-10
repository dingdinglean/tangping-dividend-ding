import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { snapshotUrls } from "../market-data.js";
import {
  APP_CACHE,
  APP_VERSION,
  SHELL_ASSETS,
  SNAPSHOT_CACHE,
  USER_DATA_KEYS,
  githubPagesSnapshotMirror,
  obsoleteCacheNames,
} from "../pwa-release.js";
import { findVersionDrift, readShippedSources, syncCacheVersion } from "../scripts/sync-cache-version.mjs";

const root = new URL("../", import.meta.url);
const read = (name) => readFile(new URL(name, root), "utf8");
const pkg = JSON.parse(await read("package.json"));

const SHIPPED = [
  "index.html",
  "app.js",
  "market-data.js",
  "market-calendar.js",
  "sw.js",
  "pwa-release.js",
  "manifest.webmanifest",
];

test("package.json version is the only shipped cache token", async () => {
  assert.equal(APP_VERSION, pkg.version);
  assert.equal(APP_CACHE, `tangping-dividend-v${pkg.version}`);
  const files = await readShippedSources();
  assert.deepEqual(findVersionDrift(pkg.version, files), []);
  assert.equal(JSON.parse(files["manifest.webmanifest"]).start_url, `./?v=${pkg.version}`);
  assert.match(files["sw.js"], /const CACHE_NAME = APP_CACHE;/);
  const literal = /\?v=(\d+\.\d+(?:\.\d+)?)/g;
  for (const name of SHIPPED) {
    const source = await read(name);
    const found = [...source.matchAll(literal)].map((match) => match[1]);
    if (["index.html", "app.js", "market-data.js", "manifest.webmanifest"].includes(name)) {
      assert.ok(found.length > 0, `${name} should cache-bust with the package version`);
    }
    for (const token of found) assert.equal(token, pkg.version, `${name} has ?v=${token}`);
  }
  const synced = await syncCacheVersion({ write: false });
  assert.equal(synced.version, pkg.version);
  assert.equal(synced.releaseChanged, false);
  assert.deepEqual(synced.files.map((file) => file.changed), [false, false, false, false]);
});

test("version drift check fails when the cache name, query, or start_url disagree", async () => {
  const files = await readShippedSources();
  const drifted = {
    ...files,
    "index.html": files["index.html"].replaceAll(`?v=${pkg.version}`, "?v=8.2"),
    "manifest.webmanifest": files["manifest.webmanifest"].replace(`"./?v=${pkg.version}"`, `"./?v=7.3"`),
    "sw.js": files["sw.js"].replace("const CACHE_NAME = APP_CACHE;", 'const CACHE_NAME = "tangping-dividend-v8.2";'),
  };
  const problems = findVersionDrift(pkg.version, drifted);
  assert.ok(problems.some((problem) => problem.includes("index.html") && problem.includes("8.2")));
  assert.ok(problems.some((problem) => problem.includes("start_url") && problem.includes("7.3")));
  assert.ok(problems.some((problem) => problem.includes("sw.js cache name")));
  assert.ok(findVersionDrift("9.9.9", files).length > 0);
});

test("shell precache lists every versioned module the pages import", async () => {
  const specifiers = [];
  for (const name of ["index.html", "app.js", "market-data.js"]) {
    const source = await read(name);
    specifiers.push(...[...source.matchAll(/["'](\.\/[^"']+\?v=[^"']+)["']/g)].map((match) => match[1]));
  }
  assert.ok(specifiers.includes(`./market-calendar.js?v=${pkg.version}`));
  assert.ok(specifiers.includes(`./pwa-release.js?v=${pkg.version}`));
  for (const specifier of specifiers) {
    assert.ok(SHELL_ASSETS.includes(specifier), `missing precache entry ${specifier}`);
  }
  assert.equal(SHELL_ASSETS.includes("./sw.js"), false);
});

test("GitHub Pages snapshot mirror follows the current project site", () => {
  const pages = { hostname: "dingdinglean.github.io", pathname: "/tangping-dividend-ding/" };
  const mirror = "https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/main/data/market.json";
  assert.equal(githubPagesSnapshotMirror(pages), mirror);
  assert.deepEqual(snapshotUrls(pages), ["./data/market.json", mirror]);
  assert.equal(githubPagesSnapshotMirror({ hostname: "dingdinglean.github.io", pathname: "/tangping-dividend-ding/sw.js" }), mirror);
  assert.deepEqual(snapshotUrls({ hostname: "someone.github.io", pathname: "/other-repo/index.html" }), [
    "./data/market.json",
    "https://raw.githubusercontent.com/someone/other-repo/main/data/market.json",
  ]);
  for (const location of [
    { hostname: "localhost", pathname: "/" },
    { hostname: "example.com", pathname: "/tangping-dividend-ding/" },
    { hostname: "dingdinglean.github.io", pathname: "/" },
    { hostname: "dingdinglean.github.io", pathname: "/index.html" },
    { hostname: "dingdinglean.github.io", pathname: "/sw.js" },
    { hostname: "dingdinglean.github.io", pathname: "/../secret" },
  ]) {
    assert.deepEqual(snapshotUrls(location), ["./data/market.json"], JSON.stringify(location));
  }
});

test("service worker hardcodes neither a release id nor a repository snapshot URL", async () => {
  const sw = await read("sw.js");
  const market = await read("market-data.js");
  assert.match(sw, /from "\.\/pwa-release\.js"/);
  assert.match(sw, /obsoleteCacheNames\(keys\)\.map\(\(key\) => caches\.delete\(key\)\)/);
  assert.match(sw, /caches\.open\(CACHE_NAME\)/);
  assert.doesNotMatch(sw, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(market, /raw\.githubusercontent\.com/);
  assert.doesNotMatch(sw, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.delete\(CACHE_NAME\)|caches\.delete\(SNAPSHOT_CACHE\)/);
  assert.match(await read("app.js"), /register\(`\.\/sw\.js\?v=\$\{APP_VERSION\}`, \{ type: "module", updateViaCache: "none" \}\)/);
});

test("cache cleanup drops old app shells and never selects user data or snapshot history", async () => {
  const storage = new Map([
    [USER_DATA_KEYS[0], JSON.stringify({ version: 1, transactions: [{ id: "tx-keep" }] })],
    [USER_DATA_KEYS[1], JSON.stringify({ marker: "keep-backup" })],
  ]);
  const before = structuredClone([...storage]);
  const existing = [
    "tangping-dividend-v8.2",
    "tangping-dividend-v7.3",
    APP_CACHE,
    SNAPSHOT_CACHE,
    ...USER_DATA_KEYS,
    "other-site-cache",
  ];
  assert.deepEqual(obsoleteCacheNames(existing), [
    "tangping-dividend-v8.2",
    "tangping-dividend-v7.3",
  ]);
  const retained = existing.filter((name) => !obsoleteCacheNames(existing).includes(name));
  assert.ok(retained.includes(APP_CACHE));
  assert.ok(retained.includes(SNAPSHOT_CACHE));
  for (const key of USER_DATA_KEYS) assert.ok(retained.includes(key));
  assert.deepEqual([...storage], before);

  const app = await read("app.js");
  assert.match(app, /const STORAGE_KEY = "tangping-dividend\.v1";/);
  assert.match(app, /const DELETE_BACKUP_KEY = "tangping-dividend\.backup-before-delete";/);
  assert.doesNotMatch(app, /STORAGE_KEY = [^;\n]*APP_VERSION/);
  assert.doesNotMatch(app, /localStorage\.clear\s*\(/);
  assert.deepEqual(USER_DATA_KEYS, ["tangping-dividend.v1", "tangping-dividend.backup-before-delete"]);
});
