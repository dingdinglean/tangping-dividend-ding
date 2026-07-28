const ALPHA_BASE = "https://www.alphavantage.co/query";
const FX_URL = "https://api.frankfurter.dev/v2/rate/USD/CNY";

async function fetchJson(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
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
  const url = `${ALPHA_BASE}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
  assertAlphaResponse(data);
  const quote = data?.["Global Quote"] || {};
  const price = Number(quote["05. price"] ?? quote.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${symbol} 未返回有效价格`);
  return {
    price,
    tradingDay: quote["07. latest trading day"] || null,
    changePercent: Number.parseFloat(String(quote["10. change percent"] || "0").replace("%", "")) || 0,
    source: "Alpha Vantage EOD",
  };
}

export async function fetchAlphaDividends(symbol, apiKey) {
  const url = `${ALPHA_BASE}?function=DIVIDENDS&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
  const data = await fetchJson(url);
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
  return { dividends, source: "Alpha Vantage Dividends" };
}

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
