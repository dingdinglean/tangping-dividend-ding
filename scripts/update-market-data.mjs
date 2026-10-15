import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestCompletedUsTradingSession, sessionDateFromTimestamp } from "../market-calendar.js";

export const SYMBOLS = ["QQQI", "SPYI", "QNDX", "SCHD"];
const ALPHA = "https://www.alphavantage.co/query";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
const NASDAQ = "https://api.nasdaq.com/api/quote/";
const NEOS = new Map([["QQQI", "https://neosfunds.com/qqqi/"], ["SPYI", "https://neosfunds.com/spyi/"]]);
const STATE_STREET = new Map([["QNDX", "https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-nasdaq-100-etf-qndx"]]);
const DAY = 86400000;
const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const validPrice = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const validDividendRate = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const time = (now) => new Date(now).toISOString();
const SAFE_ERRORS = new Set(["invalid_data", "quota_exhausted", "price_date_stale", "api_key_missing", "api_not_entitled", "request_timeout", "daily_budget_exhausted"]);
const errorCode = (e) => SAFE_ERRORS.has(e?.message) ? e.message : /^http_\d{3}$/.test(e?.message || "") ? e.message : e?.name === "TimeoutError" || e?.name === "AbortError" ? "request_timeout" : "upstream_unavailable";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function isoDate(value) { const text = String(value || "").trim(); if (validDate(text)) return text; const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text); return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : text; }

function safePrice(row) {
  if (!validPrice(row?.price) || !validDate(row?.price_date) || !row.source || !Number.isFinite(Date.parse(row.fetched_at))) return null;
  return { symbol: String(row.symbol || ""), price: Number(row.price), price_date: row.price_date, source: String(row.source), fetched_at: new Date(row.fetched_at).toISOString() };
}
function safeDividends(row) {
  const data = (row?.data || []).map((item) => ({ ex_date: isoDate(item.ex_date || item.ex_dividend_date || item.exDate), payment_date: isoDate(item.payment_date || item.paymentDate || ""), amount: Number(item.amount) }))
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
  if (!response.ok) throw new Error(response.status === 429 ? "quota_exhausted" : `http_${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== "object") throw new Error("invalid_data");
  if (body.Note || body.Information || body["Error Message"]) {
    const notice = String(body.Note || body.Information || body["Error Message"]);
    throw new Error(/rate|limit|frequency|requests per|call volume/i.test(notice) ? "quota_exhausted" : /premium|subscribe|entitlement/i.test(notice) ? "api_not_entitled" : "invalid_data");
  }
  return body;
}
async function html(fetcher, url) { const response = await fetcher(url, { signal: AbortSignal.timeout(18000), headers: { Accept: "text/html" } }); if (!response.ok) throw new Error("upstream_unavailable"); return response.text(); }

export async function fetchAlphaPrice(symbol, apiKey, fetcher, fetched_at) {
  if (!apiKey) throw new Error("api_key_missing"); const url = new URL(ALPHA); url.search = new URLSearchParams({ function: "GLOBAL_QUOTE", symbol, apikey: apiKey }).toString();
  const quote = (await json(fetcher, url))["Global Quote"] || {}; if (!validPrice(quote["05. price"]) || !validDate(quote["07. latest trading day"])) throw new Error("invalid_data");
  return { symbol, price: Number(quote["05. price"]), price_date: quote["07. latest trading day"], source: "Alpha Vantage EOD", fetched_at };
}
export async function fetchYahooPrice(symbol, fetcher, fetched_at, targetDate = latestCompletedUsTradingSession(Date.parse(fetched_at)).date) {
  const url = new URL(`${YAHOO}${encodeURIComponent(symbol)}`); url.search = new URLSearchParams({ range: "10d", interval: "1d", includePrePost: "false" }).toString();
  const data = (await json(fetcher, url)).chart?.result?.[0]; const stamps = data?.timestamp || []; const closes = data?.indicators?.quote?.[0]?.close || [];
  const rows = stamps.map((stamp, index) => ({ price: Number(closes[index]), price_date: sessionDateFromTimestamp(Number(stamp) * 1000) })).filter((row) => validPrice(row.price) && validDate(row.price_date)).sort((a, b) => b.price_date.localeCompare(a.price_date));
  if (!rows.length) throw new Error("invalid_data");
  const row = rows.find(row => row.price_date === targetDate);
  if (!row) throw Object.assign(new Error("price_date_stale"), { priceDate: rows[0].price_date });
  return { symbol, ...row, source: "Yahoo Finance Chart", fetched_at };
}
export async function fetchNasdaqHistoricalPrice(symbol, fetcher, fetched_at, targetDate) {
  if (!validDate(targetDate)) throw new Error("invalid_data");
  const target = Date.parse(`${targetDate}T00:00:00Z`);
  const formatNasdaqDate = (value) => new Date(value).toISOString().slice(0, 10);
  const url = new URL(`${NASDAQ}${encodeURIComponent(symbol)}/historical`);
  url.search = new URLSearchParams({
    assetclass: "etf",
    fromdate: formatNasdaqDate(target - 10 * DAY),
    todate: formatNasdaqDate(target),
    limit: "20",
  }).toString();
  const body = await json(fetcher, url);
  const rows = body.data?.tradesTable?.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error("invalid_data");
  const match = rows.find((row) => isoDate(row.date) === targetDate);
  if (!match) throw Object.assign(new Error("price_date_stale"), { priceDate: rows.map(row => isoDate(row.date)).filter(validDate).sort().at(-1) });
  const price = Number(String(match.close ?? match.closeLast ?? match["close/last"] ?? match.lastSalePrice ?? "").replace(/[$,]/g, "").trim());
  if (!validPrice(price)) throw new Error("invalid_data");
  return { symbol, price, price_date: targetDate, source: "Nasdaq historical close", fetched_at };
}
export async function fetchNasdaqPrice(symbol, fetcher, fetched_at) {
  const url = new URL(`${NASDAQ}${encodeURIComponent(symbol)}/info`); url.search = new URLSearchParams({ assetclass: "etf" }).toString();
  const body = await json(fetcher, url); const quote = body.data?.secondaryData || {};
  const match = /(?:Closed at\s*)?([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(String(quote.lastTradeTimestamp || ""));
  const months = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
  const price = Number(String(quote.lastSalePrice || "").replace(/[^0-9.]/g, "")); const price_date = match ? `${match[3]}-${months[match[1]]}-${match[2].padStart(2, "0")}` : "";
  if (!validPrice(price) || !validDate(price_date)) throw new Error("invalid_data"); return { symbol, price, price_date, source: "Nasdaq official close", fetched_at };
}
export async function fetchNasdaqDividends(symbol, fetcher, fetched_at) {
  const url = new URL(`${NASDAQ}${encodeURIComponent(symbol)}/dividends`); url.search = new URLSearchParams({ assetclass: "etf" }).toString();
  const body = await json(fetcher, url); const rows = body.data?.dividends?.rows || [];
  const result = safeDividends({ data: rows.map((row) => ({
    ex_date: row.exOrEffDate || row.exDate || row.ex_dividend_date,
    payment_date: row.paymentDate || row.payment_date || "",
    amount: String(row.amount || row.dividendRate || row.dividend || "").replace(/[$,]/g, ""),
  })), source: "Nasdaq official dividends", fetched_at });
  if (!result) throw new Error("invalid_data"); return result;
}
export async function fetchAlphaDividends(symbol, apiKey, fetcher, fetched_at) {
  if (!apiKey) throw new Error("api_key_missing"); const url = new URL(ALPHA); url.search = new URLSearchParams({ function: "DIVIDENDS", symbol, apikey: apiKey }).toString();
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
function stateStreetDate(plain) {
  const match = /Yields\s+as of\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})/i.exec(plain);
  return match && MONTHS[match[1]] ? `${match[3]}-${MONTHS[match[1]]}-${match[2].padStart(2, "0")}` : null;
}
function labelledPercent(plain, label) {
  const match = new RegExp(`${label}(?:\\s*\\([^)]*\\))?[^%]{0,700}?([0-9]+(?:\\.[0-9]+)?)%`, "i").exec(plain);
  return match && validDividendRate(Number(match[1]) / 100) ? Number(match[1]) / 100 : null;
}
// State Street may publish a Fund/Trailing Distribution Yield in the future.
// QNDX currently publishes only its 30 Day SEC Yield, which must remain a
// separate, explicitly labelled metric rather than pretending to be TTM.
export async function fetchStateStreetYield(symbol, fetcher, fetched_at) {
  const url = STATE_STREET.get(symbol); if (!url) throw new Error("invalid_data");
  const plain = (await html(fetcher, url)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  const data_date = stateStreetDate(plain); if (!data_date) throw new Error("invalid_data");
  const fundDistributionYield = labelledPercent(plain, "(?:Fund|Trailing)\\s+Distribution\\s+Yield");
  if (fundDistributionYield) return { rate: fundDistributionYield, data_date, source: "State Street official Fund Distribution Yield", kind: "fund_distribution_yield", yield_type: "Fund Distribution Yield", coverage: "complete", fetched_at, status: "valid" };
  const secYield = labelledPercent(plain, "30\\s*Day\\s+SEC\\s+Yield");
  if (secYield) return { rate: secYield, data_date, source: "State Street official 30 Day SEC Yield", kind: "30_day_sec_yield", yield_type: "30 Day SEC Yield", coverage: "complete", fetched_at, status: "valid" };
  throw new Error("invalid_data");
}
export async function fetchFrankfurter(fetcher, fetched_at) { const body = await json(fetcher, "https://api.frankfurter.dev/v2/rate/USD/CNY"); if (!validPrice(body.rate) || !validDate(body.date)) throw new Error("invalid_data"); return { rate: Number(body.rate), fx_date: body.date, source: "Frankfurter", fetched_at }; }
export async function fetchOpenExchangeRate(fetcher, fetched_at) { const body = await json(fetcher, "https://open.er-api.com/v6/latest/USD"); const fx_date = sessionDateFromTimestamp(Number(body.time_last_update_unix || 0) * 1000) || fetched_at.slice(0, 10); if (!validPrice(body.rates?.CNY) || !validDate(fx_date)) throw new Error("invalid_data"); return { rate: Number(body.rates.CNY), fx_date, source: "Open Exchange Rates", fetched_at }; }
function ttm(dividends, price, target, fetched_at) { const cutoff = Date.parse(`${target}T00:00:00Z`) - 365 * DAY; const rows = dividends?.data?.filter((row) => Date.parse(`${row.ex_date}T00:00:00Z`) >= cutoff) || []; const oldest = dividends?.data?.at(-1)?.ex_date; if (!rows.length || !oldest || Date.parse(`${oldest}T00:00:00Z`) > cutoff) return { coverage: "insufficient", data_date: dividends?.data?.[0]?.ex_date || null, source: dividends?.source || "" }; const annual_per_share = rows.reduce((sum, row) => sum + row.amount, 0); return { rate: annual_per_share / price.price, annual_per_share, data_date: rows[0].ex_date, source: dividends.source, kind: "ttm_distribution_yield", yield_type: "TTM Distribution Yield", coverage: "complete", fetched_at }; }
function isUsableDividendRate(row) { return validDividendRate(row?.rate) && validDate(row?.data_date) && typeof row?.source === "string" && row.source.length > 0; }
function staleDividendRate(row) { return { ...row, status: "stale" }; }
async function resolveOrdinaryDividendRate({ symbol, dividends, dividendsFresh, price, target, fetched_at, old, fetcher }) {
  let official;
  if (STATE_STREET.has(symbol)) try { official = await fetchStateStreetYield(symbol, fetcher, fetched_at); } catch {}
  // A literal fund distribution yield wins. A 30 Day SEC Yield is a clearly
  // typed official stopgap only while verified TTM distributions are incomplete.
  if (official?.kind === "fund_distribution_yield") return official;
  if (!dividendsFresh && !official && isUsableDividendRate(old)) return staleDividendRate(old);
  const calculated = dividends && price ? ttm(dividends, price, target, fetched_at) : null;
  if (calculated?.coverage === "complete") return { ...calculated, status: dividendsFresh ? "valid" : "stale" };
  if (official) return official;
  if (isUsableDividendRate(old)) return staleDividendRate(old);
  return calculated || { coverage: "insufficient", data_date: null, source: "Distributions unavailable", status: "unavailable" };
}

export function summarizePrices(snapshot) {
  const target = snapshot.refresh.target_price_date;
  const valid = SYMBOLS.filter(symbol => snapshot.symbols[symbol]?.price_status === "valid" && snapshot.symbols[symbol]?.price?.price_date === target);
  const missing = SYMBOLS.filter(symbol => !valid.includes(symbol));
  const updated = SYMBOLS.filter(symbol => snapshot.refresh.price_attempts.some(entry => entry.symbol === symbol && entry.status === "success"));
  const failed = SYMBOLS.filter(symbol => !updated.includes(symbol));
  return { status: !failed.length ? "complete" : valid.length || updated.length ? "partial" : "failed", valid: valid.length, total: SYMBOLS.length, stale_symbols: missing, updated: updated.length, failed_symbols: failed };
}

export async function updateSnapshot({ previous = {}, apiKey = "", fetcher = fetch, now = Date.now(), priceAttempts = 1, retryDelays = [45000, 90000], waiter = sleep, logger = () => {}, alphaMinIntervalMs = 0 } = {}) {
  const snapshot = previousSnapshot(previous);
  const fetched_at = time(now);
  const session = latestCompletedUsTradingSession(now);
  const usageDate = fetched_at.slice(0, 10);
  const priorUsage = previous.refresh?.alpha_vantage_usage;
  const usage = { date: usageDate, count: priorUsage?.date === usageDate ? Math.max(0, Number(priorUsage.count) || 0) : 0 };
  snapshot.generatedAt = fetched_at;
  snapshot.refresh = { target_price_date: session.date, generated_at: fetched_at, alpha_vantage_usage: usage, price_attempts: [] };
  let alphaBlocked = false;
  let alphaLastCall = null;
  const limitedFetcher = async (url, options) => {
    if (new URL(url).hostname === "www.alphavantage.co") {
      if (alphaBlocked || usage.count >= 25) throw new Error("daily_budget_exhausted");
      const delay = alphaLastCall === null ? 0 : Math.max(0, alphaMinIntervalMs - (Date.now() - alphaLastCall));
      if (delay) await waiter(delay);
      usage.count += 1;
      alphaLastCall = Date.now();
      const response = await fetcher(url, options);
      // Inspect only to stop repeated rate-limit calls. Never log the URL/body/key.
      if (response.status === 429) alphaBlocked = true;
      if (typeof response.clone === "function") {
        try { const body = await response.clone().json(); if (/rate|limit|frequency|requests per|call volume/i.test(String(body.Note || body.Information || ""))) alphaBlocked = true; } catch {}
      }
      return response;
    }
    return fetcher(url, options);
  };
  const record = (entry) => { snapshot.refresh.price_attempts.push(entry); logger(entry); };
  const refreshPrice = async (symbol, round) => {
    const old = snapshot.symbols[symbol] || {};
    let price;
    let priceError = "upstream_unavailable";
    for (const [source, resolvePrice] of [
      ["Nasdaq", () => fetchNasdaqHistoricalPrice(symbol, limitedFetcher, fetched_at, session.date)],
      ["Alpha Vantage", () => fetchAlphaPrice(symbol, apiKey, limitedFetcher, fetched_at)],
      ["Yahoo", () => fetchYahooPrice(symbol, limitedFetcher, fetched_at, session.date)],
    ]) {
      try {
        const row = await resolvePrice();
        if (row.price_date !== session.date) throw Object.assign(new Error("price_date_stale"), { priceDate: row.price_date });
        price = row;
        record({ symbol, source, round, status: "success", price_date: row.price_date, price: row.price });
        break;
      } catch (e) {
        const error = errorCode(e);
        if (source === "Alpha Vantage" && error === "quota_exhausted") alphaBlocked = true;
        if (priceError !== "price_date_stale" || error === "price_date_stale") priceError = error;
        record({ symbol, source, round, status: "error", ...(validDate(e.priceDate) ? { price_date: e.priceDate } : {}), error });
      }
    }
    const current = price || (old.price?.price_date === session.date ? old.price : null);
    snapshot.symbols[symbol] = { ...old, ...(price ? { price } : {}), price_status: current ? "valid" : "stale", expected_price_date: session.date };
    if (!current) snapshot.symbols[symbol].price_error = priceError;
    else delete snapshot.symbols[symbol].price_error;
    return price;
  };
  for (const symbol of SYMBOLS) {
    const old = snapshot.symbols[symbol] || {};
    const price = await refreshPrice(symbol, 1);
    let dividends; let dividendsFresh = false;
    try { dividends = await fetchNasdaqDividends(symbol, limitedFetcher, fetched_at); dividendsFresh = true; } catch { try { dividends = await fetchAlphaDividends(symbol, apiKey, limitedFetcher, fetched_at); dividendsFresh = true; } catch { try { dividends = await fetchYahooDividends(symbol, limitedFetcher, fetched_at); dividendsFresh = true; } catch { dividends = old.dividends; } } }
    if (dividends) snapshot.symbols[symbol].dividends = dividends;
    if (NEOS.has(symbol)) { try { snapshot.symbols[symbol].dividend_rate = await fetchNeosDistributionRate(symbol, fetcher, fetched_at); } catch { snapshot.symbols[symbol].dividend_rate = isUsableDividendRate(old.dividend_rate) ? staleDividendRate(old.dividend_rate) : { coverage: "insufficient", source: "NEOS official Distribution Rate", status: "unavailable" }; } }
    else snapshot.symbols[symbol].dividend_rate = await resolveOrdinaryDividendRate({ symbol, dividends: snapshot.symbols[symbol].dividends, dividendsFresh, price: price || old.price, target: session.date, fetched_at, old: old.dividend_rate, fetcher });
  }
  try { snapshot.fx = await fetchFrankfurter(fetcher, fetched_at); } catch { try { snapshot.fx = await fetchOpenExchangeRate(fetcher, fetched_at); } catch { snapshot.fx = snapshot.fx ? { ...snapshot.fx, status: "stale" } : { status: "unavailable" }; } }
  for (let round = 2; round <= Math.min(3, Math.max(1, priceAttempts)); round++) {
    const missing = SYMBOLS.filter(symbol => snapshot.symbols[symbol].price_status !== "valid");
    if (!missing.length) break;
    await waiter(Math.max(0, retryDelays[round - 2] ?? 90000));
    for (const symbol of missing) {
      const price = await refreshPrice(symbol, round);
      const row = snapshot.symbols[symbol];
      if (price && row.dividend_rate?.kind === "ttm_distribution_yield") {
        const rate = ttm(row.dividends, price, session.date, fetched_at);
        if (rate.coverage === "complete") row.dividend_rate = { ...rate, status: row.dividend_rate.status || "valid" };
      }
    }
  }
  snapshot.refresh.summary = summarizePrices(snapshot);
  logger({ type: "summary", ...snapshot.refresh.summary });
  return snapshot;
}
export async function run({ apiKey = process.env.ALPHA_VANTAGE_API_KEY || "", output = fileURLToPath(new URL("../data/market.json", import.meta.url)), ...options } = {}) {
  let previous = {};
  try { previous = JSON.parse(await readFile(output, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("旧快照读取失败，已停止写入以保留原文件"); }
  const snapshot = await updateSnapshot({ priceAttempts: 3, alphaMinIntervalMs: 12000, ...options, previous, apiKey });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
  await rename(`${output}.tmp`, output);
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = await run({ logger: entry => console.log(JSON.stringify(entry)) });
    const summary = snapshot.refresh.summary;
    const text = `目标收盘日 ${snapshot.refresh.target_price_date}；有效收盘价 ${summary.valid}/${summary.total}；本次获取 ${summary.updated}/${summary.total}${summary.failed_symbols.length ? `；获取失败 ${summary.failed_symbols.join(", ")}` : ""}${summary.stale_symbols.length ? `；过期 ${summary.stale_symbols.join(", ")}` : ""}`;
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## 行情更新：${summary.status}\n\n${text}\n`);
    if (summary.status !== "complete") process.exitCode = 1;
  } catch {
    console.error("行情快照更新失败，旧文件已保留；请检查网络与配置。");
    process.exitCode = 1;
  }
}
