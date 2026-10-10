// package.json "version" is the only release id.
// Bump that field, then run `npm run sync-version`.
// npm test fails if APP_VERSION or any shipped `?v=` token drifts.
//
// This id names Cache Storage and cache-busting URLs only.
// Holdings stay in localStorage under tangping-dividend.v1 (app.js STORAGE_KEY).
// Do not interpolate APP_VERSION into that key.

export const APP_VERSION = "7.3.0";

export const APP_CACHE = `tangping-dividend-v${APP_VERSION}`;

// Independent of APP_VERSION so an app upgrade can still serve the last good snapshot.
export const SNAPSHOT_CACHE = "tangping-market-snapshots-v2";

export const USER_DATA_KEYS = Object.freeze([
  "tangping-dividend.v1",
  "tangping-dividend.backup-before-delete",
]);

export const SHELL_ASSETS = Object.freeze([
  "./",
  "./index.html",
  `./styles.css?v=${APP_VERSION}`,
  `./app.js?v=${APP_VERSION}`,
  `./market-data.js?v=${APP_VERSION}`,
  `./market-calendar.js?v=${APP_VERSION}`,
  `./pwa-release.js?v=${APP_VERSION}`,
  `./manifest.webmanifest?v=${APP_VERSION}`,
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
]);

// Project pages are https://owner.github.io/repo/...
// A first path segment with a dot is a file (index.html, sw.js), not a repository.
export function githubPagesSnapshotMirror(location) {
  const hostname = String(location?.hostname || "");
  const suffix = ".github.io";
  if (!hostname.endsWith(suffix)) return "";
  const owner = hostname.slice(0, -suffix.length);
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return "";
  const repo = String(location?.pathname || "").split("/").filter(Boolean)[0] || "";
  if (!/^[A-Za-z0-9_-]+$/.test(repo)) return "";
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/market.json`;
}

export function snapshotUrls(location, snapshotPath = "./data/market.json") {
  const mirror = githubPagesSnapshotMirror(location);
  return mirror ? [snapshotPath, mirror] : [snapshotPath];
}

// Names passed to caches.delete during activate. Storage keys are never selected.
export function obsoleteCacheNames(existingNames, currentAppCache = APP_CACHE, snapshotCache = SNAPSHOT_CACHE) {
  const keep = new Set([currentAppCache, snapshotCache]);
  return [...existingNames].filter((name) => {
    if (typeof name !== "string" || keep.has(name) || USER_DATA_KEYS.includes(name)) return false;
    return name.startsWith("tangping-dividend-");
  });
}
