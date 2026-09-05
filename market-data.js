const ALPHA_BASE = "https://www.alphavantage.co/query";
const FX_URL = "https://api.frankfurter.dev/v2/rate/USD/CNY";
let marketEndpoint = "";
export const SNAPSHOT_PATH = "./data/market.json";
const SNAPSHOT_MIRROR = "https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/main/data/market.json";
let snapshotPromise = null;
let snapshotLoadedAt = 0;

export function snapshotUrls(location = globalThis.location) {
  return location?.hostname === "dingdinglean.github.io" && location.pathname.startsWith("/tangping-dividend-ding/")
    ? [SNAPSHOT_PATH, SNAPSHOT_MIRROR] : [SNAPSHOT_PATH];
}

export function parseSnapshot(snapshot, symbol, kind) {
  if (snapshot?.schemaVersion !== 1 || !snapshot.symbols || typeof snapshot.symbols !== "object") throw new Error("静态行情快照格式无效");
  if (!["GLOBAL_QUOTE", "DIVIDENDS", "TIME_SERIES_MONTHLY_ADJUSTED", "OVERVIEW"].includes(kind)) throw new Error("未知行情类型");
  const row = Object.hasOwn(snapshot.symbols, symbol) ? snapshot.symbols[symbol]?.[kind] : null;
  if (!row || !row._fetchedAt || !Number.isFinite(Date.parse(row._fetchedAt))) throw new Error(`${symbol} 静态行情尚未生成，请检查 Actions 运行状态`);
  return { ...row, _snapshot: true, _refreshWarning: row._status === "error" ? "Actions 本次更新失败，保留上次有效数据" : null };
}

async function loadSnapshot() {
  if (!snapshotPromise || Date.now() - snapshotLoadedAt > 60000) {
    snapshotLoadedAt = Date.now();
    snapshotPromise = Promise.allSettled(snapshotUrls().map(readSnapshotCopy)).then((results) => {
      const valid = results.filter((r) => r.status === "fulfilled" && r.value?.schemaVersion === 1 && r.value.symbols && typeof r.value.symbols === "object").map((r) => r.value);
      if (!valid.length) throw new Error("暂时无法读取静态行情，请检查 Actions 或网络；已有行情仍保留");
      // GITHUB_TOKEN commits don't trigger legacy Pages builds; use the newer public copy.
      return valid.sort((a,b) => (Date.parse(b.generatedAt) || 0) - (Date.parse(a.generatedAt) || 0))[0];
    }).catch((error) => { snapshotPromise = null; throw error; });
  }
  return snapshotPromise;
}

async function readSnapshotCopy(url) {
  let cache;
  const cacheKey = globalThis.location ? new URL(url, globalThis.location.href).href : url;
  try { if (globalThis.caches) cache = await caches.open("tangping-market-snapshots-v1"); } catch { /* Cache storage may be unavailable. */ }
  try {
    const body = await fetchJson(url);
    if (body?.schemaVersion !== 1 || !body.symbols || typeof body.symbols !== "object") throw new Error("invalid snapshot");
    // Also populate Cache Storage before a newly installed SW controls the page.
    try { if (cache) await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })); } catch { /* Fresh network data remains usable. */ }
    return body;
  } catch (error) {
    try { const cached = await cache?.match(cacheKey); if (cached) return await cached.json(); } catch { /* Preserve the original network error. */ }
    throw error;
  }
}

async function alphaData(kind, symbol, apiKey) {
  if (marketEndpoint === SNAPSHOT_PATH) return parseSnapshot(await loadSnapshot(), symbol, kind);
  return fetchJson(alphaUrl(kind, symbol, apiKey));
}

const sourceName = (data, name) => data._snapshot ? `GitHub Actions · ${name}` : name;

export function configureMarketEndpoint(value = "") {
  if (value !== marketEndpoint) { snapshotPromise = null; snapshotLoadedAt = 0; }
  if (value === SNAPSHOT_PATH) { marketEndpoint = value; return; }
  if (!value) { marketEndpoint = ""; return; }
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
    throw new Error("共享服务请填写无参数的 HTTPS 地址（本机测试允许 HTTP）");
  }
  marketEndpoint = url.href;
}

function alphaUrl(kind, symbol, apiKey) {
  const url = new URL(marketEndpoint || ALPHA_BASE);
  url.searchParams.set("function", kind);
  url.searchParams.set("symbol", symbol);
  // Never send a personal API key to a configured proxy.
  if (!marketEndpoint) url.searchParams.set("apikey", apiKey);
  return url.href;
}

async function fetchJson(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(response.status === 429 ? "行情请求额度已用完，请稍后重试" : `HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function assertAlphaResponse(data) {
  const message = data?.["Error Message"] || data?.Note || data?.Information;
  if (message) {
    if (/frequency|rate limit|25 requests|call volume/i.test(message)) {
      throw new Error("Alpha Vantage 今日请求额度可能已用完");
    }
    if (/API key/i.test(message)) throw new Error("Alpha Vantage API Key 无效或尚未生效");
    throw new Error(String(message).replace(/\*\*/g, "").slice(0, 160));
  }
}

export async function fetchUsdCnyRate() {
  const data = await fetchJson(FX_URL);
  const rate = Number(data?.rate ?? data?.rates?.CNY);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("汇率数据格式异常");
  return {
    rate,
    date: data?.date || new Date().toISOString().slice(0, 10),
    source: "Frankfurter",
  };
}

export async function fetchAlphaQuote(symbol, apiKey) {
  const data = await alphaData("GLOBAL_QUOTE", symbol, apiKey);
  assertAlphaResponse(data);
  const quote = data?.["Global Quote"] || {};
  const price = Number(quote["05. price"] ?? quote.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${symbol} 未返回有效价格`);
  return {
    price,
    fetchedAt: data._fetchedAt || null,
    refreshWarning: data._refreshWarning || null,
    tradingDay: quote["07. latest trading day"] || null,
    changePercent: Number.parseFloat(String(quote["10. change percent"] || "0").replace("%", "")) || 0,
    source: sourceName(data, "Alpha Vantage EOD"),
  };
}

export async function fetchAlphaDividends(symbol, apiKey) {
  const data = await alphaData("DIVIDENDS", symbol, apiKey);
  assertAlphaResponse(data);
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.dividends) ? data.dividends : [];
  const dividends = rows.map((row) => ({
    exDate: row.ex_dividend_date || row.exDate || "",
    declarationDate: row.declaration_date || row.declarationDate || "",
    recordDate: row.record_date || row.recordDate || "",
    paymentDate: row.payment_date || row.paymentDate || "",
    amount: Number(row.amount),
  })).filter((row) => row.exDate && Number.isFinite(row.amount) && row.amount >= 0)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  return { dividends, source: sourceName(data, "Alpha Vantage Dividends"), quality: "exact", fetchedAt: data._fetchedAt || null, refreshWarning: data._refreshWarning || null };
}

export async function fetchAlphaMonthlyAdjustedDividends(symbol, apiKey) {
  const data = await alphaData("TIME_SERIES_MONTHLY_ADJUSTED", symbol, apiKey);
  assertAlphaResponse(data);
  const series = data?.["Monthly Adjusted Time Series"] || data?.["Monthly Time Series"] || {};
  const dividends = Object.entries(series).map(([date, row]) => ({
    // 月度调整序列只提供月份，不提供精确除息/到账日。仅用于收益率估算。
    exDate: date,
    declarationDate: "",
    recordDate: "",
    paymentDate: "",
    amount: Number(row?.["7. dividend amount"] ?? row?.dividend_amount ?? 0),
    datePrecision: "month",
    canAutoCreate: false,
  })).filter((row) => row.exDate && Number.isFinite(row.amount) && row.amount > 0)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  if (!dividends.length) throw new Error(`${symbol} 月度序列未返回股息记录`);
  return {
    dividends,
    fetchedAt: data._fetchedAt || null,
    source: sourceName(data, "Alpha Vantage Monthly Adjusted"),
    refreshWarning: data._refreshWarning || null,
    quality: "monthly",
  };
}

export async function fetchAlphaOverviewDividend(symbol, apiKey) {
  const data = await alphaData("OVERVIEW", symbol, apiKey);
  assertAlphaResponse(data);
  const annualDividendPerShare = Number(data?.DividendPerShare);
  const dividendYield = Number(data?.DividendYield);
  if ((!Number.isFinite(annualDividendPerShare) || annualDividendPerShare <= 0) && (!Number.isFinite(dividendYield) || dividendYield <= 0)) {
    throw new Error(`${symbol} 概览未返回股息数据`);
  }
  return {
    annualDividendPerShare: Number.isFinite(annualDividendPerShare) && annualDividendPerShare > 0 ? annualDividendPerShare : 0,
    fetchedAt: data._fetchedAt || null,
    dividendYield: Number.isFinite(dividendYield) && dividendYield > 0 ? dividendYield : 0,
    exDate: data?.ExDividendDate || "",
    paymentDate: data?.DividendDate || "",
    source: sourceName(data, "Alpha Vantage Overview"),
    refreshWarning: data._refreshWarning || null,
    quality: "snapshot",
  };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
