const CACHE_NAME = "tangping-dividend-v7.1";
const SNAPSHOT_CACHE = "tangping-market-snapshots-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=7.1",
  "./app.js?v=7.1",
  "./market-data.js?v=7.1",
  "./manifest.webmanifest?v=7.1",
  "./icon.svg",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("tangping-dividend-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();

  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const snapshotUrl = new URL("./data/market.json", self.location.href).href;
  const mirrorUrl = "https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/main/data/market.json";
  if (url.href === snapshotUrl || url.href === mirrorUrl) {
    event.respondWith((async () => {
      const cache = await caches.open(SNAPSHOT_CACHE);
      try {
        const response = await fetch(event.request, { cache: "no-store" });
        if (!response.ok) throw new Error("snapshot unavailable");
        const body = await response.clone().json();
        if (body.schemaVersion !== 1 || !body.symbols || typeof body.symbols !== "object") throw new Error("invalid snapshot");
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
      .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : Response.error())))
  );
});
