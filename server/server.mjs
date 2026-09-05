import http from "node:http";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const hour = 3600000;
const functions = new Map([["GLOBAL_QUOTE", 18 * hour], ["DIVIDENDS", 24 * hour], ["TIME_SERIES_MONTHLY_ADJUSTED", 7 * 24 * hour], ["OVERVIEW", 7 * 24 * hour]]);

// Only public market data lives here. No portfolios, personal keys or transactions.
export async function createMarketService({ apiKey = "", symbols = ["QQQI", "SPYI", "QNDX", "SCHD"], budget = 25, cacheFile, fetcher = fetch, now = Date.now } = {}) {
  const allowed = new Set(symbols);
  let data = { day: "", used: 0, cache: {}, failures: {} };
  if (cacheFile) {
    try { data = { ...data, ...JSON.parse(await readFile(cacheFile, "utf8")) }; }
    catch (error) { if (error.code !== "ENOENT") throw new Error("行情缓存无法读取，请先检查文件；未重置请求预算"); }
  }
  let queue = Promise.resolve();
  async function persist() {
    if (!cacheFile) return;
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(`${cacheFile}.tmp`, JSON.stringify(data), { mode: 0o600 });
    await rename(`${cacheFile}.tmp`, cacheFile);
  }
  async function getData(kind, symbol) {
    if (!functions.has(kind) || !allowed.has(symbol)) throw Object.assign(new Error("不支持的标的或数据类型"), { status: 400 });
    const key = `${kind}:${symbol}`;
    const cached = data.cache[key];
    if (cached && now() - cached.at < functions.get(kind)) return { ...cached.body, _fetchedAt: new Date(cached.at).toISOString() };
    if (!apiKey) throw Object.assign(new Error("后台尚未配置行情密钥"), { status: 503 });
    const day = new Date(now()).toISOString().slice(0, 10);
    if (data.day !== day) { data.day = day; data.used = 0; }
    if (data.used >= budget) throw Object.assign(new Error("今日共享行情请求预算已用完"), { status: 429 });
    if (data.failures[key] && now() - data.failures[key] < hour / 2) throw Object.assign(new Error("上游暂不可用，稍后自动重试"), { status: 503 });
    data.used += 1;
    await persist(); // Count before requesting, including failed upstream requests.
    try {
      const url = new URL("https://www.alphavantage.co/query");
      url.search = new URLSearchParams({ function: kind, symbol, apikey: apiKey }).toString();
      const response = await fetcher(url, { signal: AbortSignal.timeout(18000) });
      if (!response.ok) throw new Error("行情上游请求失败");
      const body = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || body.Note || body.Information || body["Error Message"]) throw new Error("上游未提供有效数据");
      const valid = kind === "GLOBAL_QUOTE" ? Number(body["Global Quote"]?.["05. price"]) > 0
        : kind === "DIVIDENDS" ? Array.isArray(body.data) || Array.isArray(body.dividends)
        : kind === "OVERVIEW" ? Number(body.DividendPerShare) > 0 || Number(body.DividendYield) > 0
        : Boolean(body["Monthly Adjusted Time Series"] || body["Monthly Time Series"]);
      if (!valid) throw new Error("上游数据格式异常");
      data.cache[key] = { at: now(), body };
      delete data.failures[key];
      await persist();
      return { ...body, _fetchedAt: new Date(data.cache[key].at).toISOString() };
    } catch {
      data.failures[key] = now();
      await persist();
      throw Object.assign(new Error("行情上游暂不可用，已保留旧缓存"), { status: 503 });
    }
  }
  const get = (kind, symbol) => {
    // Serialize requests and recheck cache: simultaneous clients consume one call.
    const task = queue.then(() => getData(kind, symbol));
    queue = task.catch(() => {});
    return task;
  };
  const warm = async () => {
    for (const symbol of allowed) {
      for (const kind of ["GLOBAL_QUOTE", "DIVIDENDS"]) {
        try { await get(kind, symbol); } catch { /* Retain cache; next scheduled tick retries. */ }
      }
    }
  };
  return { get, warm };
}

const staticFiles = new Map([
  ["/", ["index.html", "text/html"]], ["/index.html", ["index.html", "text/html"]],
  ["/app.js", ["app.js", "text/javascript"]], ["/market-data.js", ["market-data.js", "text/javascript"]],
  ["/styles.css", ["styles.css", "text/css"]], ["/sw.js", ["sw.js", "text/javascript"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ...["icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"].map((name) => [`/${name}`, [name, name.endsWith("svg") ? "image/svg+xml" : "image/png"]]),
]);

export function createServer(service, allowedOrigin = "") {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/market") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Vary", "Origin");
        if (req.headers.origin) {
          const ownOrigin = `http://${req.headers.host}`;
          if (req.headers.origin !== allowedOrigin && req.headers.origin !== ownOrigin) { res.writeHead(403); res.end(); return; }
          res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        }
        const body = await service.get(url.searchParams.get("function"), url.searchParams.get("symbol"));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
        return;
      }
      const file = staticFiles.get(url.pathname);
      if (!file) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
      res.end(await readFile(resolve(root, file[0])));
    } catch (error) {
      if (!res.headersSent) res.writeHead(error.status || 503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "行情暂不可用，请稍后重试" }));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = await createMarketService({ apiKey: process.env.ALPHA_VANTAGE_API_KEY,
    symbols: (process.env.MARKET_SYMBOLS || "QQQI,SPYI,QNDX,SCHD").split(",").map((s) => s.trim()).filter(Boolean),
    budget: Math.max(1, Number(process.env.MARKET_DAILY_BUDGET) || 25),
    cacheFile: resolve(process.env.MARKET_CACHE_FILE || resolve(root, ".market-cache/data.json")) });
  const server = createServer(service, process.env.ALLOWED_ORIGIN || "");
  server.listen(Number(process.env.PORT) || 4173, process.env.HOST || "127.0.0.1", () => console.log("躺平股息服务已启动"));
  if (process.env.ALPHA_VANTAGE_API_KEY) {
    service.warm();
    const timer = setInterval(() => service.warm(), hour);
    server.on("close", () => clearInterval(timer));
  }
}
