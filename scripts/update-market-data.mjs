import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestCompletedUsTradingSession, sessionDateFromTimestamp } from "../market-calendar.js";

export const SYMBOLS = ["QQQI", "SPYI", "QNDX", "SCHD"];
const ALPHA = "https://www.alphavantage.co/query";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
const NASDAQ = "https://api.nasdaq.com/api/quote/";
const NEOS = new Map([["QQQI", "https://neosfunds.com/qqqi/"], ["SPYI", "https://neosfunds.com/spyi/"]]);
const DAY = 86400000;
const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const validPrice = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const time = (now) => new Date(now).toISOString();
const errorCode = (e) => ["invalid_data", "quota_exhausted", "price_date_stale"].includes(e?.message) ? e.message : "upstream_unavailable";

function safePrice(row) {
  if (!validPrice(row?.price) || !validDate(row?.price_date) || !row.source || !Number.isFinite(Date.parse(row.fetched_at))) return null;
  return { symbol: String(row.symbol || ""), price: Number(row.price), price_date: row.price_date, source: String(row.source), fetched_at: new Date(row.fetched_at).toISOString() };
}
function safeDividends(row) {
  const data = (row?.data || []).map((item) => ({ ex_date: item.ex_date || item.ex_dividend_date || item.exDate, payment_date: item.payment_date || item.paymentDate || "", amount: Number(item.amount) }))
    .filter((item) => validDate(item.ex_date) && validPrice(item.amount)).sort((a, b) => b.ex_date.localeCompare(a.ex_date));
  return data.length ? { data, source: String(row.source || ""), fetched_at: Number.isFinite(Date.parse(row.fetched_at)) ? new Date(row.fetched_at).toISOString() : null } : null;
}
function previousSnapshot(input) {
  const result = { schemaVersion: 2, generatedAt: null, refresh: {}, fx: null, symbols: {} };
  for (const symbol of SYMBOLS) {
    const old = input?.symbols?.[symbol] || {}; const legacy = old.GLOBAL_QUOTE?.["Global Quote"];
    const price = safePrice(old.price) || (validPrice(legacy?.["05. price"]) && validDate(legacy?.["07. latest trading day"]) ?
      safePrice({ symbol, price: legacy["05. price"], price_date: legacy["07. latest trading day"], source: "Alpha Vantage EOD (legacy)", fetched_at: old.GLOBAL_QUOTE?._fetchedAt || input.generatedAt }) : null);
    const dividends = safeDividends(old.dividends) || safeDividends({ data: old.DIVIDENDS?.data, source: "Alpha Vantage Dividends (legacy)", fetched_at: old.DIVIDENDS?._fetchedAt });
    result.symbols[symbol] = { ...(price ? { price } : {}), ...(dividends ? { dividends } : {}), ...(old.dividend_rate ? { dividend_rate: old.dividend_rate } : {}) };
  }
  if (validPrice(input?.fx?.rate) && validDate(input.fx.fx_date) && input.fx.source && Number.isFinite(Date.parse(input.fx.fetched_at))) result.fx = { rate: Number(input.fx.rate), fx_date: input.fx.fx_date, source: String(input.fx.source), fetched_at: new Date(input.fx.fetched_at).toISOString() };
  return result;
}
async function json(fetcher, url) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(18000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.status === 429 ? "quota_exhausted" : "upstream_unavailable");
  const body = await response.json();
  if (!body || typeof body !== "object" || body.Note || body.Information || body["Error Message"]) throw new Error("upstream_unavailable");
  return body;
}
async function html(fetcher, url) { const response = await fetcher(url, { signal: AbortSignal.timeout(18000), headers: { Accept: "text/html" } }); if (!response.ok) throw new Error("upstream_unavailable"); return response.text(); }

export async function fetchAlphaPrice(symbol, apiKey, fetcher, fetched_at) {
  if (!apiKey) throw new Error("upstream_unavailable"); const url = new URL(ALPHA); url.search = new URLSearchParams({ function: "GLOBAL_QUOTE", symbol, apikey: apiKey }).toString();
  const quote = (await json(fetcher, url))["Global Quote"] || {}; if (!validPrice(quote["05. price"]) || !validDate(quote["07. latest trading day"])) throw new Error("invalid_data");
  return { symbol, price: Number(quote["05. price"]), price_date: quote["07. latest trading day"], source: "Alpha Vantage EOD", fetched_at };
}
export async function fetchYahooPrice(symbol, fetcher, fetched_at) {
  const url = new URL(`${YAHOO}${encodeURIComponent(symbol)}`); url.search = new URLSearchParams({ range: "10d", interval: "1d", includePrePost: "false" }).toString();
  const data = (await json(fetcher, url)).chart?.result?.[0]; const stamps = data?.timestamp || []; const closes = data?.indicators?.quote?.[0]?.close || [];
  const rows = stamps.map((stamp, index) => ({ price: Number(closes[index]), price_date: sessionDateFromTimestamp(Number(stamp) * 1000) })).filter((row) => validPrice(row.price) && validDate(row.price_date)).sort((a, b) => b.price_date.localeCompare(a.price_date));
  if (!rows.length) throw new Error("invalid_data"); return { symbol, ...rows[0], source: "Yahoo Finance Chart", fetched_at };
}
export async function fetchNasdaqPrice(symbol, fetcher, fetched_at) {
  const url = new URL(`${NASDAQ}${encodeURIComponent(symbol)}/info`); url.search = new URLSearchParams({ assetclass: "etf" }).toString();
  const body = await json(fetcher, url); const quote = body.data?.secondaryData || {};
  const match = /(?:Closed at\s*)?([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(String(quote.lastTradeTimestamp || ""));
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const price = Number(String(quote.lastSalePrice || "").replace(/[^0-9.]/g, "")); const price_date = match ? `${match[3]}-${months[match[1]]}-${match[2].padStart(2, "0")}` : "";
  if (!validPrice(price) || !validDate(price_date)) throw new Error("invalid_data"); return { symbol, price, price_date, source: "Nasdaq official close", fetched_at };
}
export async function fetchAlphaDividends(symbol, apiKey, fetcher, fetched_at) {
  if (!apiKey) throw new Error("upstream_unavailable"); const url = new URL(ALPHA); url.search = new URLSearchParams({ function: "DIVIDENDS", symbol, apikey: apiKey }).toString();
  const body = await json(fetcher, url); const result = safeDividends({ data: body.data || body.dividends, source: "Alpha Vantage Dividends", fetched_at }); if (!result) throw new Error("invalid_data"); return result;
}
export async function fetchYahooDividends(symbol, fetcher, fetched_at) {
  const url = new URL(`${YAHOO}${encodeURIComponent(symbol)}`); url.search = new URLSearchParams({ range: "2y", interval: "1d", events: "div" }).toString();
  const events = (await json(fetcher, url)).chart?.result?.[0]?.events?.dividends || {};
  const result = safeDividends({ data: Object.values(events).map((row) => ({ ex_date: sessionDateFromTimestamp(Number(row.date) * 1000), amount: row.amount })), source: "Yahoo Finance Dividends", fetched_at }); if (!result) throw new Error("invalid_data"); return result;
}
export async function fetchNeosDistributionRate(symbol, fetcher, fetched_at) {
  const url = NEOS.get(symbol); if (!url) throw new Error("invalid_data");
  const plain = (await html(fetcher, url)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  const rate = /Distribution\s*Rate(?:\s*Image[^%]{0,120})?\s*([0-9]+(?:\.[0-9]+)?)%/i.exec(plain); const asOf = /(?:Distribution Information\s*)?\(?\s*as of\s*([0-9]{1,2})[\/-]([0-9]{1,2})[\/-]([0-9]{4})/i.exec(plain);
  if (!rate || !asOf) throw new Error("invalid_data"); return { rate: Number(rate[1]) / 100, data_date: `${asOf[3]}-${asOf[1].padStart(2, "0")}-${asOf[2].padStart(2, "0")}`, source: "NEOS official Distribution Rate", kind: "distribution_rate", fetched_at };
}
export async function fetchFrankfurter(fetcher, fetched_at) { const body = await json(fetcher, "https://api.frankfurter.dev/v2/rate/USD/CNY"); if (!validPrice(body.rate) || !validDate(body.date)) throw new Error("invalid_data"); return { rate: Number(body.rate), fx_date: body.date, source: "Frankfurter", fetched_at }; }
export async function fetchOpenExchangeRate(fetcher, fetched_at) { const body = await json(fetcher, "https://open.er-api.com/v6/latest/USD"); const fx_date = sessionDateFromTimestamp(Number(body.time_last_update_unix || 0) * 1000) || fetched_at.slice(0, 10); if (!validPrice(body.rates?.CNY) || !validDate(fx_date)) throw new Error("invalid_data"); return { rate: Number(body.rates.CNY), fx_date, source: "Open Exchange Rates", fetched_at }; }
function ttm(dividends, price, target, fetched_at) { const cutoff = Date.parse(`${target}T00:00:00Z`) - 365 * DAY; const rows = dividends?.data?.filter((row) => Date.parse(`${row.ex_date}T00:00:00Z`) >= cutoff) || []; const oldest = dividends?.data?.at(-1)?.ex_date; if (!rows.length || !oldest || Date.parse(`${oldest}T00:00:00Z`) > cutoff) return { coverage: "insufficient", data_date: dividends?.data?.[0]?.ex_date || null, source: dividends?.source || "" }; const annual_per_share = rows.reduce((sum, row) => sum + row.amount, 0); return { rate: annual_per_share / price.price, annual_per_share, data_date: rows[0].ex_date, source: dividends.source, kind: "ttm_distribution_yield", coverage: "complete", fetched_at }; }

export async function updateSnapshot({ previous = {}, apiKey = "", fetcher = fetch, now = Date.now() } = {}) {
  const snapshot = previousSnapshot(previous); const fetched_at = time(now); const session = latestCompletedUsTradingSession(now); snapshot.generatedAt = fetched_at; snapshot.refresh = { target_price_date: session.date, generated_at: fetched_at };
  for (const symbol of SYMBOLS) {
    const old = snapshot.symbols[symbol] || {}; let price; let priceError = "upstream_unavailable";
    try { const row = await fetchAlphaPrice(symbol, apiKey, fetcher, fetched_at); if (row.price_date === session.date) price = row; else priceError = "price_date_stale"; } catch (e) { priceError = errorCode(e); }
    if (!price) try { const row = await fetchNasdaqPrice(symbol, fetcher, fetched_at); if (row.price_date === session.date) price = row; else priceError = "price_date_stale"; } catch (e) { if (priceError !== "price_date_stale") priceError = errorCode(e); }
    if (!price) try { const row = await fetchYahooPrice(symbol, fetcher, fetched_at); if (row.price_date === session.date) price = row; else priceError = "price_date_stale"; } catch (e) { if (priceError !== "price_date_stale") priceError = errorCode(e); }
    // A failed retry must not invalidate an already verified close for this same
    // completed session. Only a record whose date lags the target is stale.
    const retainedCurrentPrice = !price && old.price?.price_date === session.date ? old.price : null;
    const validSessionPrice = price || retainedCurrentPrice;
    snapshot.symbols[symbol] = { ...old, ...(price ? { price } : {}), price_status: validSessionPrice ? "valid" : "stale", expected_price_date: session.date };
    if (!validSessionPrice) snapshot.symbols[symbol].price_error = priceError; else delete snapshot.symbols[symbol].price_error;
    let dividends; try { dividends = await fetchAlphaDividends(symbol, apiKey, fetcher, fetched_at); } catch { try { dividends = await fetchYahooDividends(symbol, fetcher, fetched_at); } catch { dividends = old.dividends; } } if (dividends) snapshot.symbols[symbol].dividends = dividends;
    if (NEOS.has(symbol)) { try { snapshot.symbols[symbol].dividend_rate = await fetchNeosDistributionRate(symbol, fetcher, fetched_at); } catch { if (!old.dividend_rate) snapshot.symbols[symbol].dividend_rate = { coverage: "insufficient", source: "NEOS official Distribution Rate" }; } }
    else if (snapshot.symbols[symbol].dividends && (price || old.price)) snapshot.symbols[symbol].dividend_rate = ttm(snapshot.symbols[symbol].dividends, price || old.price, session.date, fetched_at);
    else snapshot.symbols[symbol].dividend_rate = { coverage: "insufficient", data_date: null, source: "Distributions unavailable" };
  }
  try { snapshot.fx = await fetchFrankfurter(fetcher, fetched_at); } catch { try { snapshot.fx = await fetchOpenExchangeRate(fetcher, fetched_at); } catch { snapshot.fx = snapshot.fx ? { ...snapshot.fx, status: "stale" } : { status: "unavailable" }; } }
  return snapshot;
}
export async function run({ apiKey = process.env.ALPHA_VANTAGE_API_KEY || "", output = fileURLToPath(new URL("../data/market.json", import.meta.url)), ...options } = {}) { let previous = {}; try { previous = JSON.parse(await readFile(output, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("旧快照读取失败，已停止写入以保留原文件"); } const snapshot = await updateSnapshot({ ...options, previous, apiKey }); await mkdir(dirname(output), { recursive: true }); await writeFile(`${output}.tmp`, JSON.stringify(snapshot, null, 2) + "\n"); await rename(`${output}.tmp`, output); return snapshot; }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { try { const snapshot = await run(); console.log(`公开行情快照完成；目标收盘日 ${snapshot.refresh.target_price_date}`); } catch { console.error("行情快照更新失败，旧文件已保留；请检查网络与配置。"); process.exitCode = 1; } }
