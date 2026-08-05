const CACHE_NAME = "tangping-dividend-v6";
const APP_VERSION = "v6";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=6",
  "./app.js?v=6",
  "./market-data.js?v=6",
  "./manifest.webmanifest?v=6",
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
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: "window" });
    await Promise.all(windows.map((client) => {
      const url = new URL(client.url);
      if (url.searchParams.get("pwa-update") === APP_VERSION) return null;
      url.searchParams.set("pwa-update", APP_VERSION);
      return client.navigate(url.href).catch(() => null);
    }));
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // 行情和汇率接口必须走网络，不能被 PWA 缓存成旧数据。
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
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
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
