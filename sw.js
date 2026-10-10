import { APP_CACHE, SNAPSHOT_CACHE, SHELL_ASSETS, obsoleteCacheNames, githubPagesSnapshotMirror } from "./pwa-release.js";

const CACHE_NAME = APP_CACHE;
const ASSETS = SHELL_ASSETS;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // 只删除旧的应用壳 Cache Storage，保留行情快照缓存。
    await Promise.all(obsoleteCacheNames(keys).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const snapshotUrl = new URL("./data/market.json", self.location.href).href;
  const mirrorUrl = githubPagesSnapshotMirror(self.location);
  if (url.href === snapshotUrl || (mirrorUrl && url.href === mirrorUrl)) {
    event.respondWith((async () => {
      const cache = await caches.open(SNAPSHOT_CACHE);
      try {
        const response = await fetch(event.request, { cache: "no-store" });
        if (!response.ok) throw new Error("snapshot unavailable");
        const body = await response.clone().json();
        if (body.schemaVersion !== 2 || !body.symbols || typeof body.symbols !== "object") throw new Error("invalid snapshot");
        await cache.put(event.request, response.clone());
        return response;
      } catch {
        return await cache.match(event.request) || Response.error();
      }
    })());
    return;
  }

  // 行情和汇率接口必须走网络，不能被 PWA 缓存成旧数据。
  const isStaticAsset = ASSETS.some((asset) => new URL(asset, self.location.href).href === url.href);
  if (url.origin !== self.location.origin || (event.request.mode !== "navigate" && !isStaticAsset)) {
    event.respondWith(fetch(event.request).catch(() => new Response("", { status: 503, statusText: "Offline" })));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(event.request))
          || (event.request.mode === "navigate" ? cache.match("./index.html") : Response.error());
      })
  );
});
