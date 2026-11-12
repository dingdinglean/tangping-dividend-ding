import { readFile, writeFile, mkdir, rename, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { latestCompletedUsTradingSession, sessionDateFromTimestamp, watchPlan } from "../market-calendar.js";

export const SYMBOLS = ["QQQI", "SPYI", "QNDX", "SCHD", "XQQI", "CHPY"];
const ALPHA = "https://www.alphavantage.co/query";
const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
const NASDAQ = "https://api.nasdaq.com/api/quote/";
const NEOS = new Map([["QQQI", "https://neosfunds.com/qqqi/"], ["SPYI", "https://neosfunds.com/spyi/"], ["XQQI", "https://neosfunds.com/xqqi/"]]);
const STATE_STREET = new Map([["QNDX", "https://www.ssga.com/us/en/individual/etfs/state-street-spdr-portfolio-nasdaq-100-etf-qndx"]]);
// US listing only. The Irish UCITS fund IE000T8QD852 also uses the ticker CHPY and is never read.
export const YIELDMAX_CHPY_URL = "https://yieldmaxetfs.com/our-etfs/chpy/";
const YIELDMAX_CHPY_CUSIP = "88636R693";
const DAY = 86400000;
const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const validPrice = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
const validDividendRate = (v) => Number.isFinite(Number(v)) && Number(v) > 0;
// Blank and unparsable cells are unreleased. A published 0 is a real amount.
export function explicitDividendAmount(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[$,]/g, "").trim();
  if (!text || !/^[+]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}
const time = (now) => new Date(now).toISOString();
const SAFE_ERRORS = new Set(["invalid_data", "quota_exhausted", "price_date_stale", "api_key_missing", "api_not_entitled", "request_timeout", "daily_budget_exhausted"]);
const errorCode = (e) => SAFE_ERRORS.has(e?.message) ? e.message : /^http_\d{3}$/.test(e?.message || "") ? e.message : e?.name === "TimeoutError" || e?.name === "AbortError" ? "request_timeout" : "upstream_unavailable";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
function isoDate(value) { const text = String(value || "").trim(); if (validDate(text)) return text; const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text); return match ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}` : text; }

function optionalFinite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function safePrice(row) {
  if (!validPrice(row?.price) || !validDate(row?.price_date) || !row.source || !Number.isFinite(Date.parse(row.fetched_at))) return null;
  const price = { symbol: String(row.symbol || ""), price: Number(row.price), price_date: row.price_date, source: String(row.source), fetched_at: new Date(row.fetched_at).toISOString() };
  const change = optionalFinite(row.change);
  const changePercent = optionalFinite(row.change_percent);
  if (change !== null) price.change = change;
  if (changePercent !== null) price.change_percent = changePercent;
  return price;
}
function safeHistory(rows) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const data = [];
  for (const row of rows) {
    const date = isoDate(row?.date || row?.price_date);
    const close = Number(String(row?.close ?? row?.price ?? "").replace(/[$,]/g, "").trim());
    if (!validDate(date) || !validPrice(close) || seen.has(date)) continue;
    seen.add(date);
    data.push({ date, close });
  }
  data.sort((a, b) => b.date.localeCompare(a.date));
  return data.length ? data.slice(0, 120) : null;
}
function safeDividends(row) {
  const data = (row?.data || []).flatMap((item) => {
    const amount = explicitDividendAmount(item?.amount);
    const ex_date = isoDate(item?.ex_date || item?.ex_dividend_date || item?.exDate);
    if (!validDate(ex_date) || amount === null) return [];
    const entry = { ex_date, amount };
    const payment = isoDate(item.payment_date || item.paymentDate || "");
    const declaration = isoDate(item.declaration_date || item.declarationDate || "");
    const record = isoDate(item.record_date || item.recordDate || "");
    if (validDate(payment)) entry.payment_date = payment;
    if (validDate(declaration)) entry.declaration_date = declaration;
    if (validDate(record)) entry.record_date = record;
    if (item.source) entry.source = String(item.source);
    if (item.amount_provenance) entry.amount_provenance = item.amount_provenance;
    return [entry];
  }).sort((a, b) => b.ex_date.localeCompare(a.ex_date) || b.amount - a.amount);
  return data.length ? { data, source: String(row.source || ""), fetched_at: Number.isFinite(Date.parse(row.fetched_at)) ? new Date(row.fetched_at).toISOString() : null } : null;
}
function previousSnapshot(input) {
  const result = { schemaVersion: 2, generatedAt: null, refresh: {}, fx: null, symbols: {} };
  for (const symbol of SYMBOLS) {
    const old = input?.symbols?.[symbol] || {}; const legacy = old.GLOBAL_QUOTE?.["Global Quote"];
    const price = safePrice(old.price) || (validPrice(legacy?.["05. price"]) && validDate(legacy?.["07. latest trading day"]) ?
      safePrice({ symbol, price: legacy["05. price"], price_date: legacy["07. latest trading day"], source: "Alpha Vantage EOD (legacy)", fetched_at: old.GLOBAL_QUOTE?._fetchedAt || input.generatedAt }) : null);
    const dividends = safeDividends(old.dividends) || safeDividends({ data: old.DIVIDENDS?.data, source: "Alpha Vantage Dividends (legacy)", fetched_at: old.DIVIDENDS?._fetchedAt });
    const history = safeHistory(old.price_history);
    result.symbols[symbol] = { ...(price ? { price } : {}), ...(history ? { price_history: history } : {}), ...(dividends ? { dividends } : {}), ...(old.dividend_rate ? { dividend_rate: old.dividend_rate } : {}), ...(old.identity ? { identity: old.identity } : {}) };
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
async function html(fetcher, url) { const response = await fetcher(url, { signal: AbortSignal.timeout(18000), headers: { Accept: "text/html" } }); if (!response.ok) throw new Error(response.status === 429 ? "quota_exhausted" : `http_${response.status || 0}`); return response.text(); }
const TRANSIENT_ERRORS = new Set(["request_timeout", "http_500", "http_502", "http_503", "http_504"]);

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
  const history = safeHistory(rows.filter((item) => item.price_date <= targetDate).map((item) => ({ date: item.price_date, close: item.price })));
  const previous = history?.find((item) => item.date < targetDate);
  const quote = { symbol, ...row, source: "Yahoo Finance Chart", fetched_at, ...(history ? { history } : {}) };
  if (previous) {
    quote.change = Number((row.price - previous.close).toFixed(4));
    quote.change_percent = Number(((row.price - previous.close) / previous.close).toFixed(6));
  }
  return quote;
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
  const history = safeHistory(rows.map((row) => ({ date: row.date, close: row.close ?? row.closeLast ?? row["close/last"] ?? row.lastSalePrice })).filter((row) => isoDate(row.date) <= targetDate));
  const previous = history?.find((row) => row.date < targetDate);
  const quote = { symbol, price, price_date: targetDate, source: "Nasdaq historical close", fetched_at, ...(history ? { history } : {}) };
  if (previous) {
    quote.change = Number((price - previous.close).toFixed(4));
    quote.change_percent = Number(((price - previous.close) / previous.close).toFixed(6));
  }
  return quote;
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
export async function fetchNeosPrice(symbol, fetcher, fetched_at) {
  const url = NEOS.get(symbol); if (!url) throw new Error("invalid_data");
  const plain = (await html(fetcher, url)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  // Closing NAV is published above this block and must never be stored as the market price.
  const match = /Pricing Information\s+Data as of\s+(\d{1,2}\/\d{1,2}\/\d{4})[\s\S]*?Closing Market Price[\s\S]*?Market Price\s+\$([0-9,.]+)(?:[\s\S]*?Daily Change\s*\(\$\)\s*([+-]?\$?[+-]?[0-9,.]+)[\s\S]*?Daily Change\s*\(%\)\s*([+-]?[0-9,.]+)\s*%)?/i.exec(plain);
  const price = Number(String(match?.[2] || "").replace(/[$,]/g, ""));
  if (!match || !validDate(isoDate(match[1])) || !validPrice(price)) throw new Error("invalid_data");
  const quote = { symbol, price, price_date: isoDate(match[1]), source: "NEOS official Closing Market Price", fetched_at };
  const change = optionalFinite(String(match[3] || "").replace(/[$,]/g, ""));
  const changePercent = optionalFinite(match[4]);
  if (change !== null) quote.change = change;
  if (changePercent !== null) quote.change_percent = Number((changePercent / 100).toFixed(6));
  return quote;
}
// Read only declared amounts from the official history table. Blank future
// calendar amounts are never forecasts or confirmed receipts.
export async function fetchNeosDividends(symbol, fetcher, fetched_at) {
  const url = NEOS.get(symbol); if (!url) throw new Error("invalid_data");
  const page = await html(fetcher, url);
  const data = [];
  for (const table of page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []) {
    const rows = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const cells = row => (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(cell => cell.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").trim());
    const header = rows.findIndex(row => /Declaration Date/i.test(row) && /Ex-Div Date/i.test(row) && /Record Date/i.test(row) && /Payable Date/i.test(row) && /Amount/i.test(row));
    if (header < 0) continue;
    for (const row of rows.slice(header + 1)) {
      const values = cells(row);
      if (values.length !== 5) continue;
      const declaration_date = isoDate(values[0]);
      const ex_date = isoDate(values[1]);
      const record_date = isoDate(values[2]);
      const payment_date = isoDate(values[3]);
      const amount = explicitDividendAmount(values[4]);
      // Blank future calendar rows stay unpublished. The 19-23% target is not an amount.
      // An explicit 0 is kept; an empty cell is not turned into one.
      if (validDate(declaration_date) && validDate(ex_date) && validDate(record_date) && validDate(payment_date) && amount !== null) data.push({ declaration_date, ex_date, record_date, payment_date, amount });
    }
  }
  const result = safeDividends({ data, source: "NEOS official Distribution History", fetched_at });
  if (!result) throw new Error("invalid_data");
  return result;
}
export async function fetchNeosDistributionRate(symbol, fetcher, fetched_at) {
  const url = NEOS.get(symbol); if (!url) throw new Error("invalid_data");
  const plain = (await html(fetcher, url)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ");
  const rate = /Distribution\s*Rate(?:\s*Image[^%]{0,120})?\s*([0-9]+(?:\.[0-9]+)?)%/i.exec(plain); const asOf = /(?:Distribution Information\s*)?\(?\s*as of\s*([0-9]{1,2})[\/-]([0-9]{1,2})[\/-]([0-9]{4})/i.exec(plain);
  if (!rate || !asOf) throw new Error("invalid_data"); return { rate: Number(rate[1]) / 100, data_date: `${asOf[3]}-${asOf[1].padStart(2, "0")}-${asOf[2].padStart(2, "0")}`, source: "NEOS official Distribution Rate", kind: "distribution_rate", fetched_at };
}
function yieldMaxPlain(page) {
  return String(page || "").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
}
// Reject the European UCITS share class before any amount is stored.
export function assertUsChpyIdentity(plain) {
  const text = String(plain || "");
  if (!text.includes(YIELDMAX_CHPY_CUSIP) || !/NYSE Arca/.test(text) || !/Semiconductor Portfolio Option Income ETF/.test(text)) throw new Error("invalid_data");
  if (/IE000T8QD852|\bUCITS\b/.test(text)) throw new Error("invalid_data");
}
export async function fetchYieldMaxPage(symbol, fetcher) {
  if (symbol !== "CHPY") throw new Error("invalid_data");
  const page = await html(fetcher, YIELDMAX_CHPY_URL);
  const plain = yieldMaxPlain(page);
  assertUsChpyIdentity(plain);
  return { page, plain };
}
export async function fetchYieldMaxPrice(symbol, fetcher, fetched_at) {
  const { plain } = await fetchYieldMaxPage(symbol, fetcher);
  const match = /Closing Price:\s*\$([0-9,.]+)[\s\S]{0,600}?As of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(plain);
  const price = Number(String(match?.[1] || "").replace(/[$,]/g, ""));
  const price_date = isoDate(match?.[2] || "");
  if (!match || !validPrice(price) || !validDate(price_date)) throw new Error("invalid_data");
  return { symbol, price, price_date, source: "YieldMax official Closing Price", fetched_at };
}
// Declared rows only. A blank amount stays unpublished and is not stored as zero.
export async function fetchYieldMaxDividends(symbol, fetcher, fetched_at) {
  const { page } = await fetchYieldMaxPage(symbol, fetcher);
  const data = [];
  for (const table of page.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []) {
    if (!/DISTRIBUTION PER SHARE/i.test(table) || !/DECLARED DATE/i.test(table) || !/EX DATE/i.test(table) || !/RECORD DATE/i.test(table) || !/PAYABLE DATE/i.test(table)) continue;
    const rows = table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
    const cells = (row) => (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((cell) => cell.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim());
    for (const row of rows) {
      const values = cells(row);
      if (values.length < 6 || /DISTRIBUTION PER SHARE/i.test(values[0])) continue;
      const amount = explicitDividendAmount(values[0]);
      const declaration_date = isoDate(values[1]);
      const ex_date = isoDate(values[2]);
      const record_date = isoDate(values[3]);
      const payment_date = isoDate(values[4]);
      if (amount === null || ![declaration_date, ex_date, record_date, payment_date].every(validDate)) continue;
      data.push({ declaration_date, ex_date, record_date, payment_date, amount });
    }
  }
  const result = safeDividends({ data, source: "YieldMax official Distribution History", fetched_at });
  if (!result) throw new Error("invalid_data");
  const plain = yieldMaxPlain(page);
  const inception = /Fund Inception:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(plain);
  result.identity = {
    name: "YieldMax Semiconductor Portfolio Option Income ETF",
    exchange: "NYSE Arca",
    cusip: YIELDMAX_CHPY_CUSIP,
    currency: "USD",
    frequency: /weekly basis/i.test(plain) ? "weekly" : null,
    inception: inception && validDate(isoDate(inception[1])) ? isoDate(inception[1]) : null,
    source: YIELDMAX_CHPY_URL,
  };
  return result;
}
export async function fetchYieldMaxDistributionRate(symbol, fetcher, fetched_at) {
  const { plain } = await fetchYieldMaxPage(symbol, fetcher);
  const rate = /([0-9]+(?:\.[0-9]+)?)%\s+Distribution Rate/i.exec(plain);
  const asOf = /Distribution Rate[\s\S]{0,240}?As of:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(plain);
  if (!rate || !asOf || !validDate(isoDate(asOf[1]))) throw new Error("invalid_data");
  return { rate: Number(rate[1]) / 100, data_date: isoDate(asOf[1]), source: "YieldMax official Distribution Rate", kind: "distribution_rate", fetched_at };
}
// A full year uses the trailing 365-day sum. A shorter listing uses the mean of
// the weeks on hand times 52 and is marked as an estimate. Neither path treats
// one weekly distribution as a monthly distribution.
export function rollingWeeklyDistributionRate(dividends, price, target, fetched_at) {
  const rows = (dividends?.data || []).flatMap((row) => {
    const amount = explicitDividendAmount(row?.amount);
    const ex_date = isoDate(row?.ex_date);
    if (!validDate(ex_date) || amount === null || ex_date > target) return [];
    return [{ ex_date, amount }];
  }).sort((a, b) => b.ex_date.localeCompare(a.ex_date));
  const source = dividends?.source || "YieldMax official Distribution History";
  if (!rows.length || !validPrice(price?.price) || !validDate(target)) {
    return { coverage: "insufficient", data_date: rows[0]?.ex_date || null, source, kind: "rolling_weekly_estimate", yield_type: "滚动周派息年化（样本不足一年）", frequency: "weekly", method: "unavailable", sample_count: rows.length, sample_span_days: 0, status: "unavailable" };
  }
  const oldest = rows.at(-1).ex_date;
  const cutoff = Date.parse(`${target}T00:00:00Z`) - 365 * DAY;
  // sample_span_days is the ex-date distance of the rows inside the statistic.
  // It is not the distance from the fund's first distribution to the newest one.
  const sampleSpanDays = (sample) => Math.round((Date.parse(`${sample[0].ex_date}T00:00:00Z`) - Date.parse(`${sample.at(-1).ex_date}T00:00:00Z`)) / DAY);
  if (Date.parse(`${oldest}T00:00:00Z`) <= cutoff) {
    const sample = rows.filter((row) => Date.parse(`${row.ex_date}T00:00:00Z`) >= cutoff);
    if (sample.length) {
      const annual_per_share = sample.reduce((sum, row) => sum + row.amount, 0);
      return { rate: annual_per_share / Number(price.price), annual_per_share, data_date: sample[0].ex_date, source, kind: "ttm_distribution_yield", yield_type: "TTM Distribution Yield", coverage: "complete", frequency: "weekly", method: "trailing_365_day_sum", sample_count: sample.length, sample_span_days: sampleSpanDays(sample), fetched_at, status: "valid" };
    }
  }
  const sample = rows.slice(0, Math.min(13, rows.length));
  const average = sample.reduce((sum, row) => sum + row.amount, 0) / sample.length;
  const annual_per_share = average * 52;
  return { rate: annual_per_share / Number(price.price), annual_per_share, data_date: sample[0].ex_date, source, kind: "rolling_weekly_estimate", yield_type: "滚动周派息年化（样本不足一年）", coverage: "estimate", frequency: "weekly", method: "mean_of_available_weeks_times_52", sample_count: sample.length, sample_span_days: sampleSpanDays(sample), fetched_at, status: "valid" };
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
  snapshot.refresh = { target_price_date: session.date, generated_at: fetched_at, alpha_vantage_usage: usage, price_attempts: [], dividend_notes: [] };
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
  // Alpha Vantage is metered, so a timeout there is not retried. Nasdaq and Yahoo
  // get two extra attempts on timeouts and 5xx before the next source is used.
  const resolveWithRetry = async (source, resolvePrice) => {
    const attempts = source === "Alpha Vantage" ? 1 : 3;
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return await resolvePrice(); }
      catch (error) {
        last = error;
        if (attempt === attempts || !TRANSIENT_ERRORS.has(errorCode(error))) throw error;
        await waiter(Math.min(5000, 750 * attempt));
      }
    }
    throw last;
  };
  const refreshPrice = async (symbol, round) => {
    const old = snapshot.symbols[symbol] || {};
    let price;
    let priceError = "upstream_unavailable";
    for (const [source, resolvePrice] of [
      ["Nasdaq", () => fetchNasdaqHistoricalPrice(symbol, limitedFetcher, fetched_at, session.date)],
      // The historical table often lags the cash close. The quote page's
      // "Closed at" print is the same official close and appears first.
      ["Nasdaq official", () => fetchNasdaqPrice(symbol, limitedFetcher, fetched_at)],
      ["Alpha Vantage", () => fetchAlphaPrice(symbol, apiKey, limitedFetcher, fetched_at)],
      ["Yahoo", () => fetchYahooPrice(symbol, limitedFetcher, fetched_at, session.date)],
    ]) {
      try {
        const row = await resolveWithRetry(source, resolvePrice);
        if (row.price_date !== session.date) throw Object.assign(new Error("price_date_stale"), { priceDate: row.price_date });
        price = withCarriedHistory(row, old);
        record({ symbol, source, round, status: "success", price_date: row.price_date, price: row.price });
        break;
      } catch (e) {
        const error = errorCode(e);
        if (source === "Alpha Vantage" && error === "quota_exhausted") alphaBlocked = true;
        if (priceError !== "price_date_stale" || error === "price_date_stale") priceError = error;
        record({ symbol, source, round, status: "error", ...(validDate(e.priceDate) ? { price_date: e.priceDate } : {}), error });
      }
    }
    let retained = old.price;
    if (!price && (symbol === "XQQI" || symbol === "CHPY")) {
      try {
        const official = symbol === "CHPY" ? await fetchYieldMaxPrice(symbol, fetcher, fetched_at) : await fetchNeosPrice(symbol, fetcher, fetched_at);
        if (official.price_date === session.date) {
          price = official;
          record({ symbol, source: symbol === "CHPY" ? "YieldMax" : "NEOS", round, status: "success", price_date: price.price_date, price: price.price });
        } else if (official.price_date < session.date && (!retained || official.price_date > retained.price_date)) retained = official;
      } catch {}
    }
    const fresh = price ? safePrice(price) : null;
    const retainedPrice = retained ? safePrice(retained) : null;
    const stored = fresh || retainedPrice;
    const history = safeHistory(price?.history) || safeHistory(old.price_history);
    const current = fresh || (retainedPrice?.price_date === session.date ? retainedPrice : null);
    snapshot.symbols[symbol] = { ...old, ...(stored ? { price: stored } : {}), ...(history ? { price_history: history } : {}), price_status: current ? "valid" : "stale", expected_price_date: session.date };
    if (!current) snapshot.symbols[symbol].price_error = priceError;
    else delete snapshot.symbols[symbol].price_error;
    return fresh;
  };
  for (const symbol of SYMBOLS) {
    const old = snapshot.symbols[symbol] || {};
    const price = await refreshPrice(symbol, 1);
    let fetched = null;
    if (symbol === "XQQI") {
      // Official amounts and payment dates are required for XQQI. A failed or
      // blank NEOS table must not be replaced with Yahoo dates or invented rows.
      try { fetched = await fetchNeosDividends(symbol, fetcher, fetched_at); }
      catch { fetched = null; }
    } else if (symbol === "CHPY") {
      // US YieldMax history only. A failed or blank table must not be replaced
      // with the European UCITS fund or with Yahoo dates.
      try { fetched = await fetchYieldMaxDividends(symbol, fetcher, fetched_at); }
      catch { fetched = null; }
    } else {
      try { fetched = await fetchNasdaqDividends(symbol, limitedFetcher, fetched_at); }
      catch { try { fetched = await fetchAlphaDividends(symbol, apiKey, limitedFetcher, fetched_at); } catch { try { fetched = await fetchYahooDividends(symbol, limitedFetcher, fetched_at); } catch { fetched = null; } } }
    }
    const merged = mergeDividends(old.dividends, fetched);
    for (const note of merged.notes) snapshot.refresh.dividend_notes.push({ symbol, ...note });
    if (merged.dividends) snapshot.symbols[symbol].dividends = { ...merged.dividends, status: merged.fresh ? "valid" : "stale" };

    if (NEOS.has(symbol)) { try { snapshot.symbols[symbol].dividend_rate = await fetchNeosDistributionRate(symbol, fetcher, fetched_at); } catch { snapshot.symbols[symbol].dividend_rate = isUsableDividendRate(old.dividend_rate) ? staleDividendRate(old.dividend_rate) : { coverage: "insufficient", source: "NEOS official Distribution Rate", status: "unavailable" }; } }
    else if (symbol === "CHPY") {
      let official = null;
      try { official = await fetchYieldMaxDistributionRate(symbol, fetcher, fetched_at); } catch {}
      const rolling = rollingWeeklyDistributionRate(snapshot.symbols[symbol].dividends, price || old.price, session.date, fetched_at);
      if (rolling.coverage === "complete" || rolling.coverage === "estimate") {
        const status = merged.fresh ? "valid" : "stale";
        snapshot.symbols[symbol].dividend_rate = { ...rolling, status, ...(official ? { official_distribution_rate: { rate: official.rate, data_date: official.data_date, source: official.source, kind: official.kind } } : {}) };
      } else snapshot.symbols[symbol].dividend_rate = isUsableDividendRate(old.dividend_rate) ? staleDividendRate(old.dividend_rate) : { ...rolling, status: "unavailable" };
      if (fetched?.identity) snapshot.symbols[symbol].identity = fetched.identity;
    }
    else snapshot.symbols[symbol].dividend_rate = await resolveOrdinaryDividendRate({ symbol, dividends: snapshot.symbols[symbol].dividends, dividendsFresh: merged.fresh, price: price || old.price, target: session.date, fetched_at, old: old.dividend_rate, fetcher });
  }
  try { snapshot.fx = await fetchFrankfurter(fetcher, fetched_at); } catch { try { snapshot.fx = await fetchOpenExchangeRate(fetcher, fetched_at); } catch { snapshot.fx = snapshot.fx ? { ...snapshot.fx, status: "stale" } : { status: "unavailable" }; } }
  for (let round = 2; round <= Math.min(4, Math.max(1, priceAttempts)); round++) {
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
  if (!snapshot.refresh.dividend_notes.length) delete snapshot.refresh.dividend_notes;
  snapshot.refresh.summary = summarizePrices(snapshot);
  const pricesCurrent = SYMBOLS.every((symbol) => snapshot.symbols[symbol]?.price_status === "valid" && snapshot.symbols[symbol]?.price?.price_date === session.date);
  snapshot.refresh.freshness = pricesCurrent ? "current" : "stale";
  logger({ type: "summary", freshness: snapshot.refresh.freshness, ...snapshot.refresh.summary });
  return snapshot;
}
function stableMarket(snapshot) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "fetched_at" || key === "generatedAt" || key === "generated_at") continue;
      out[key] = strip(value[key]);
    }
    return out;
  };
  return JSON.stringify(strip({
    target: snapshot?.refresh?.target_price_date || null,
    freshness: snapshot?.refresh?.freshness || null,
    fx: snapshot?.fx || null,
    symbols: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, snapshot?.symbols?.[symbol] || null])),
  }));
}
function withCarriedHistory(price, old) {
  if (!price || price.history) return price;
  const history = safeHistory([...(old?.price_history || []), { date: price.price_date, close: price.price }]);
  if (!history) return price;
  const previous = history.find((item) => item.date < price.price_date);
  const quote = { ...price, history };
  if (previous && quote.change == null) {
    quote.change = Number((quote.price - previous.close).toFixed(4));
    quote.change_percent = Number(((quote.price - previous.close) / previous.close).toFixed(6));
  }
  return quote;
}
function hasDividendHistory(row) {
  const dividends = row?.dividends?.data;
  return Array.isArray(dividends) && dividends.length > 0 && dividends.every((item) => validDate(item.ex_date) && explicitDividendAmount(item.amount) !== null);
}
const DIVIDEND_SOURCE_RANK = new Map([
  ["NEOS official Distribution History", 100],
  ["YieldMax official Distribution History", 100],
  ["Nasdaq official dividends", 80],
  ["Alpha Vantage Dividends", 60],
  ["Yahoo Finance Dividends", 40],
]);
function dividendSourceRank(source) {
  return DIVIDEND_SOURCE_RANK.get(source) ?? (source ? 10 : 0);
}
function datedDividend(row) {
  return validDate(row?.payment_date) || validDate(row?.declaration_date) || validDate(row?.record_date);
}
function copyKnownDates(base, incoming, allowReplace) {
  const out = { ...base };
  for (const key of ["declaration_date", "record_date", "payment_date"]) {
    if (!validDate(incoming?.[key])) continue;
    if (!validDate(out[key]) || (allowReplace && out[key] !== incoming[key])) out[key] = incoming[key];
  }
  return out;
}
function richerRow(rows) {
  return [...rows].sort((a, b) => Number(datedDividend(b)) - Number(datedDividend(a)))[0];
}
// Merge by ex date. A shorter, empty, or blank feed cannot delete a known row
// or replace a known amount with a blank. A same-or-higher-priority source may
// correct an amount; the previous amount stays on the row. Two different
// explicit amounts on one ex date are both kept. A lower-priority source that
// disagrees is reported and does not override.
export function mergeDividends(previous, incoming) {
  const priorSource = String(previous?.source || "");
  const incomingSource = String(incoming?.source || "");
  const priorRows = (previous?.data || []).flatMap((item) => {
    const amount = explicitDividendAmount(item?.amount);
    const ex_date = isoDate(item?.ex_date);
    if (!validDate(ex_date) || amount === null) return [];
    return [{ ...item, ex_date, amount, source: item.source || priorSource }];
  });
  const incomingRows = (incoming?.data || []).flatMap((item) => {
    const amount = explicitDividendAmount(item?.amount);
    const ex_date = isoDate(item?.ex_date);
    if (!validDate(ex_date) || amount === null) return [];
    return [{ ...item, ex_date, amount, source: incomingSource || item.source || "" }];
  });
  const notes = [];
  const blanks = (incoming?.data || []).filter((item) => validDate(isoDate(item?.ex_date)) && explicitDividendAmount(item?.amount) === null);
  for (const item of blanks) notes.push({ kind: "missing_amount", ex_date: isoDate(item.ex_date), source: incomingSource });
  if (!incoming || !incomingRows.length) {
    return {
      dividends: previous?.data?.length ? previous : null,
      fresh: false,
      notes: notes.length ? notes : [{ kind: "empty_or_failed", kept: priorRows.length, source: incomingSource }],
    };
  }
  const priorLatest = priorRows.map((row) => row.ex_date).sort().at(-1) || "";
  const incomingLatest = incomingRows.map((row) => row.ex_date).sort().at(-1) || "";
  const priorRank = dividendSourceRank(priorSource);
  const incomingRank = dividendSourceRank(incomingSource);
  const priorDated = priorRows.some(datedDividend);
  const incomingDated = incomingRows.some(datedDividend);
  const truncated = priorRows.length >= 12 && incomingRows.length * 2 < priorRows.length;
  const rejectPartial = priorRows.length > 0 && incomingLatest <= priorLatest && incomingRank <= priorRank && ((priorDated && !incomingDated) || truncated);
  if (rejectPartial) {
    return {
      dividends: previous?.data ? previous : { data: priorRows, source: priorSource, fetched_at: previous?.fetched_at || null },
      fresh: false,
      notes: [{ kind: "rejected_partial", kept: priorRows.length, incoming: incomingRows.length, latest: incomingLatest || null, source: incomingSource }],
    };
  }
  const byEx = new Map();
  for (const row of priorRows) {
    const list = byEx.get(row.ex_date) || [];
    list.push(row);
    byEx.set(row.ex_date, list);
  }
  const incomingByEx = new Map();
  for (const row of incomingRows) {
    const list = incomingByEx.get(row.ex_date) || [];
    list.push(row);
    incomingByEx.set(row.ex_date, list);
  }
  for (const [ex, rows] of incomingByEx) {
    const distinct = [];
    for (const row of rows) {
      const same = distinct.find((item) => item.amount === row.amount);
      if (same) Object.assign(same, copyKnownDates(same, row, true));
      else distinct.push(row);
    }
    const prior = byEx.get(ex) || [];
    if (distinct.length > 1) {
      const kept = prior.map((row) => ({ ...row }));
      for (const row of distinct) {
        const match = kept.find((item) => item.amount === row.amount);
        if (match) Object.assign(match, copyKnownDates(match, row, incomingRank >= dividendSourceRank(match.source || priorSource)));
        else kept.push(row);
        notes.push({ kind: "distinct_amounts", ex_date: ex, amount: row.amount, source: incomingSource });
      }
      byEx.set(ex, kept);
      continue;
    }
    const row = distinct[0];
    if (!prior.length) {
      byEx.set(ex, [row]);
      continue;
    }
    if (prior.length > 1) {
      const match = prior.find((item) => item.amount === row.amount);
      if (match) byEx.set(ex, prior.map((item) => item.amount === row.amount ? copyKnownDates(item, row, incomingRank >= dividendSourceRank(item.source || priorSource)) : item));
      else notes.push({ kind: "conflict", ex_date: ex, kept_amount: prior.map((item) => item.amount), kept_source: prior[0].source || priorSource, incoming_amount: row.amount, incoming_source: incomingSource });
      continue;
    }
    const old = prior[0];
    if (old.amount === row.amount) {
      byEx.set(ex, [copyKnownDates(old, row, incomingRank >= dividendSourceRank(old.source || priorSource))]);
      continue;
    }
    if (incomingRank >= dividendSourceRank(old.source || priorSource)) {
      const history = Array.isArray(old.amount_provenance) ? old.amount_provenance : [];
      const corrected = copyKnownDates({ ...old, amount: row.amount, source: incomingSource || old.source }, row, true);
      corrected.amount_provenance = [...history, { previous_amount: old.amount, previous_source: old.source || priorSource || "snapshot", source: incomingSource }];
      byEx.set(ex, [corrected]);
      notes.push({ kind: "correction", ex_date: ex, previous_amount: old.amount, amount: row.amount, previous_source: old.source || priorSource, source: incomingSource });
    } else {
      notes.push({ kind: "conflict", ex_date: ex, kept_amount: old.amount, kept_source: old.source || priorSource, incoming_amount: row.amount, incoming_source: incomingSource });
    }
  }
  for (const [ex, rows] of byEx) {
    if (!incomingByEx.has(ex)) notes.push({ kind: "preserved_absent", ex_date: ex, amount: richerRow(rows)?.amount ?? null, source: richerRow(rows)?.source || priorSource });
  }
  const parentSource = incomingRank >= priorRank ? (incomingSource || priorSource) : (priorSource || incomingSource);
  const data = [...byEx.values()].flat().map((row) => {
    const entry = { ...row };
    if (!entry.source || entry.source === parentSource) delete entry.source;
    return entry;
  }).sort((a, b) => b.ex_date.localeCompare(a.ex_date) || b.amount - a.amount);
  notes.sort((a, b) => String(a.kind).localeCompare(String(b.kind)) || String(a.ex_date).localeCompare(String(b.ex_date)) || String(a.amount ?? "").localeCompare(String(b.amount ?? "")));
  const built = { data, source: parentSource, fetched_at: incoming.fetched_at || previous?.fetched_at || null };
  const sameRows = JSON.stringify(data) === JSON.stringify(previous?.data || []);
  return {
    dividends: sameRows && parentSource === priorSource ? (previous?.data ? previous : built) : built,
    fresh: true,
    notes,
  };
}
export function buildRunSummary({ snapshot, plan, fresh }) {
  const summary = snapshot?.refresh?.summary || {};
  const target = snapshot?.refresh?.target_price_date || "unknown";
  const lines = SYMBOLS.map((symbol) => {
    const row = snapshot?.symbols?.[symbol] || {};
    const price = row.price || {};
    const dividends = row.dividends || {};
    const latest = dividends.data?.[0];
    const attempt = [...(snapshot?.refresh?.price_attempts || [])].reverse().find((entry) => entry.symbol === symbol);
    const fetchedThisRun = price.fetched_at && price.fetched_at === snapshot?.generatedAt;
    const sessionState = row.price_status === "valid" && price.price_date === target
      ? "current"
      : attempt?.error === "price_date_stale" || (attempt?.price_date && attempt.price_date !== target)
        ? "source_returned_older_session"
        : fetchedThisRun ? "fetched_this_run_not_current" : "preserved_last_good";
    return [
      symbol,
      `price ${price.price ?? "—"}`,
      `price_date ${price.price_date || "—"}`,
      `expected ${row.expected_price_date || target}`,
      `price_status ${row.price_status || "—"}`,
      `session ${sessionState}`,
      `price_source ${price.source || "—"}`,
      `price_fetched_at ${price.fetched_at || "—"}`,
      `dividends ${dividends.data?.length || 0}`,
      `latest_ex ${latest?.ex_date || "—"}`,
      `latest_amount ${latest?.amount ?? "—"}`,
      `dividend_source ${dividends.source || "—"}`,
      `dividend_status ${dividends.status || "—"}`,
      `dividend_fetched_at ${dividends.fetched_at || "—"}`,
    ].join(" | ");
  });
  const notes = snapshot?.refresh?.dividend_notes || [];
  const header = [
    `新鲜度 ${snapshot?.refresh?.freshness || "unknown"}`,
    `观察目标 ${plan?.targetDate || "unknown"}`,
    `阶段 ${plan?.phase || "unknown"}`,
    `北京截止 ${plan?.deadline ? new Date(plan.deadline).toISOString() : "unknown"}`,
    `目标收盘日 ${target}`,
    `有效收盘价 ${summary.valid ?? "—"}/${summary.total ?? SYMBOLS.length}`,
    `本次获取 ${summary.updated ?? "—"}/${summary.total ?? SYMBOLS.length}`,
    fresh ? "本次对齐观察目标" : "本次未对齐观察目标",
  ].join("；");
  return { header, lines, notes };
}
export function snapshotIsPublishable(snapshot) {
  const summary = snapshot?.refresh?.summary;
  const target = snapshot?.refresh?.target_price_date;
  if (!summary || summary.status !== "complete" || snapshot.refresh?.freshness !== "current" || !validDate(target)) return false;
  return SYMBOLS.every((symbol) => {
    const row = snapshot.symbols?.[symbol];
    return row?.price_status === "valid" && validPrice(row?.price?.price) && row?.price?.price_date === target && hasDividendHistory(row);
  });
}
// A failed refresh may still be written when every ticker keeps a real last
// close and its dividend history, and any quote older than the completed
// session is explicitly stale. Timestamp-only repeats are not rewritten.
export function snapshotIsRecordable(snapshot) {
  const target = snapshot?.refresh?.target_price_date;
  if (!validDate(target) || (snapshot?.refresh?.freshness !== "current" && snapshot?.refresh?.freshness !== "stale")) return false;
  if (!Number.isFinite(Date.parse(snapshot?.generatedAt || ""))) return false;
  return SYMBOLS.every((symbol) => {
    const row = snapshot.symbols?.[symbol];
    const price = row?.price;
    if (!validPrice(price?.price) || !validDate(price?.price_date) || !hasDividendHistory(row)) return false;
    if (row.price_status === "valid" && price.price_date === target) return true;
    return row.price_status === "stale" && typeof row.price_error === "string" && price.price_date < target;
  });
}
export async function run({ apiKey = process.env.ALPHA_VANTAGE_API_KEY || "", output = fileURLToPath(new URL("../data/market.json", import.meta.url)), ...options } = {}) {
  let previous = {};
  let hadFile = true;
  try { previous = JSON.parse(await readFile(output, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("旧快照读取失败，已停止写入以保留原文件"); hadFile = false; }
  const snapshot = await updateSnapshot({ priceAttempts: 4, retryDelays: [20000, 60000, 180000], alphaMinIntervalMs: 12000, ...options, previous, apiKey });
  const durable = snapshotIsPublishable(snapshot) || snapshotIsRecordable(snapshot);
  if (!durable || (hadFile && stableMarket(previous) === stableMarket(snapshot))) return snapshot;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
  await rename(`${output}.tmp`, output);
  return snapshot;
}
export async function runWatch({ now = () => Date.now(), waiter = sleep, pollMs = 180000, ...options } = {}) {
  const initial = watchPlan(now());
  options.logger?.({ type: "watch", phase: initial.phase, target: initial.targetDate, wait_until: new Date(initial.waitUntil).toISOString(), deadline: new Date(initial.deadline).toISOString() });
  if (initial.phase === "wait" && initial.waitUntil > now()) await waiter(initial.waitUntil - now());
  let snapshot;
  let plan = initial;
  for (;;) {
    const at = now();
    plan = watchPlan(at);
    snapshot = await run({ priceAttempts: 2, retryDelays: [15000], waiter, ...options, now: at });
    const aligned = snapshot?.refresh?.freshness === "current" && snapshot?.refresh?.target_price_date === plan.targetDate;
    if (aligned) return { snapshot, plan, fresh: true };
    if (at >= plan.deadline || plan.phase === "final") return { snapshot, plan, fresh: false };
    const pause = Math.min(pollMs, Math.max(0, plan.deadline - now()));
    if (pause <= 0) return { snapshot, plan, fresh: false };
    options.logger?.({ type: "watch", phase: "poll", target: plan.targetDate, pause_ms: pause });
    await waiter(pause);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { snapshot, plan, fresh } = await runWatch({ logger: entry => console.log(JSON.stringify(entry)) });
    const report = buildRunSummary({ snapshot, plan, fresh });
    const summary = snapshot.refresh.summary;
    const text = `${report.header}${summary.failed_symbols?.length ? `；获取失败 ${summary.failed_symbols.join(", ")}` : ""}${summary.stale_symbols?.length ? `；过期 ${summary.stale_symbols.join(", ")}` : ""}`;
    console.log(text);
    for (const line of report.lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const noteLines = report.notes.length ? report.notes.map((note) => `- ${note.symbol || ""} ${note.kind} ${note.ex_date || ""} ${note.amount ?? note.previous_amount ?? ""} ${note.source || note.incoming_source || ""}`.trim()) : ["- 无派息合并异常"];
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [
        `## 行情更新：${fresh ? "current" : "stale"}`,
        "",
        report.header,
        "",
        "收盘价是否最新只看行情日期是否等于观察目标。任务在收盘前会等到纽约 16:00（提前收盘日 13:00）之后 10 分钟；未到北京 08:00 截止前会继续重试。GitHub 可以整次不创建 schedule 运行，本任务无法补回没有创建的事件。",
        "",
        "### 每只标的",
        "",
        ...report.lines.map((line) => `- ${line}`),
        "",
        "### 派息合并",
        "",
        ...noteLines,
        "",
        `调度：event=${process.env.GITHUB_EVENT_NAME || "local"} schedule=${process.env.SCHEDULE_CRON || "n/a"} actor=${process.env.GITHUB_ACTOR || "local"} triggering_actor=${process.env.GITHUB_TRIGGERING_ACTOR || "n/a"} run=${process.env.GITHUB_RUN_ID || "local"}`,
        "",
      ].join("\n"));
    }
    if (!fresh) process.exitCode = 1;
  } catch {
    console.error("行情快照更新失败，旧文件已保留；请检查网络与配置。");
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, "\n行情快照更新失败，旧文件已保留。\n");
    process.exitCode = 1;
  }
}
