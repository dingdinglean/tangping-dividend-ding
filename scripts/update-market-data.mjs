import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SYMBOLS = ["QQQI", "SPYI", "QNDX", "SCHD"];
export const FUNCTIONS = ["GLOBAL_QUOTE", "DIVIDENDS", "TIME_SERIES_MONTHLY_ADJUSTED", "OVERVIEW"];
const HOUR = 3600000;
const TTL = [18 * HOUR, 24 * HOUR, 7 * 24 * HOUR, 7 * 24 * HOUR];
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : "";
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const numeric = (value) => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value));

// Strict allowlist: never persist vendor error text, URLs, credentials or arbitrary fields.
export function publicPayload(kind, input, symbol) {
  if (!input || input.Note || input.Information || input["Error Message"]) throw new Error("invalid_data");
  if (kind === "GLOBAL_QUOTE") {
    const row = input["Global Quote"];
    if (!numeric(row?.["05. price"]) || Number(row["05. price"]) <= 0) throw new Error("invalid_data");
    const change = Number.parseFloat(row["10. change percent"]);
    return { "Global Quote": { "01. symbol": symbol, "05. price": Number(row["05. price"]),
      "07. latest trading day": date(row["07. latest trading day"]), "10. change percent": Number.isFinite(change) ? `${change}%` : "0%" } };
  }
  if (kind === "DIVIDENDS") {
    const rows = input.data || input.dividends;
    if (!Array.isArray(rows)) throw new Error("invalid_data");
    const data = rows.filter((row) => date(row.ex_dividend_date) && numeric(row.amount) && Number(row.amount) >= 0).map((row) => ({
      ex_dividend_date: date(row.ex_dividend_date), payment_date: date(row.payment_date),
      declaration_date: date(row.declaration_date), record_date: date(row.record_date), amount: Number(row.amount),
    })).sort((a,b) => b.ex_dividend_date.localeCompare(a.ex_dividend_date));
    if (!data.length) throw new Error("invalid_data");
    return { data };
  }
  if (kind === "TIME_SERIES_MONTHLY_ADJUSTED") {
    const rows = input["Monthly Adjusted Time Series"];
    const entries = Object.entries(rows || {}).filter(([key,row]) => date(key) && numeric(row?.["7. dividend amount"]) && Number(row["7. dividend amount"]) > 0)
      .sort(([a],[b]) => b.localeCompare(a)).map(([key,row]) => [key, { "7. dividend amount": Number(row["7. dividend amount"]) }]);
    if (!entries.length) throw new Error("invalid_data");
    return { "Monthly Adjusted Time Series": Object.fromEntries(entries) };
  }
  if (kind === "OVERVIEW") {
    const perShare = numeric(input.DividendPerShare) ? Math.max(0, Number(input.DividendPerShare)) : 0;
    const dividendYield = numeric(input.DividendYield) ? Math.max(0, Number(input.DividendYield)) : 0;
    if (!perShare && !dividendYield) throw new Error("invalid_data");
    return { DividendPerShare: perShare, DividendYield: dividendYield, ExDividendDate: date(input.ExDividendDate), DividendDate: date(input.DividendDate) };
  }
  throw new Error("invalid_function");
}

function cleanPrevious(previous) {
  const result = { schemaVersion: 1, generatedAt: timestamp(previous?.generatedAt),
    refresh: { day: date(previous?.refresh?.day), requests: Math.min(25, Math.max(0, Math.floor(Number(previous?.refresh?.requests) || 0))) }, symbols: {} };
  for (const symbol of SYMBOLS) {
    const records = {};
    for (const kind of FUNCTIONS) {
      const old = previous?.symbols?.[symbol]?.[kind];
      if (!old) continue;
      let payload = {};
      try { payload = publicPayload(kind, old, symbol); } catch { /* Keep only safe failure metadata. */ }
      records[kind] = { ...payload, _fetchedAt: Object.keys(payload).length ? timestamp(old._fetchedAt) : null,
        _lastAttemptAt: timestamp(old._lastAttemptAt), _status: old._status === "ok" ? "ok" : "error" };
      if (["upstream_unavailable", "invalid_data", "quota_exhausted"].includes(old._error)) records[kind]._error = old._error;
    }
    if (Object.keys(records).length) result.symbols[symbol] = records;
  }
  return result;
}

export async function updateSnapshot({ previous = {}, apiKey, fetcher = fetch, now = Date.now(), onProgress = async () => {}, pause = () => new Promise(r => setTimeout(r, 1000)) } = {}) {
  if (!String(apiKey || "").trim()) throw new Error("缺少 GitHub Secret ALPHA_VANTAGE_API_KEY；请在仓库 Settings → Secrets and variables → Actions 中配置。");
  const snapshot = cleanPrevious(previous);
  const currentTime = new Date(now).toISOString();
  const today = currentTime.slice(0,10);
  const persist = async () => {
    // Even a malicious upstream string cannot leak the key through a valid public field.
    if (JSON.stringify(snapshot).includes(apiKey)) throw new Error("快照安全检查失败，未写入文件");
    await onProgress(snapshot);
  };
  const request = async (symbol, kind) => {
    const old = snapshot.symbols[symbol]?.[kind];
    const age = now - Date.parse(old?._fetchedAt || "");
    if (age >= 0 && age < TTL[FUNCTIONS.indexOf(kind)] && old?._status === "ok") return true;
    const retryAge = now - Date.parse(old?._lastAttemptAt || "");
    if (old?._status === "error" && retryAge >= 0 && retryAge < HOUR / 2) return false;
    if (snapshot.refresh.day !== today) snapshot.refresh = { day: today, requests: 0 };
    if (snapshot.refresh.requests >= 25) return false;
    snapshot.refresh.requests += 1;
    snapshot.generatedAt = currentTime;
    snapshot.symbols[symbol] ||= {};
    snapshot.symbols[symbol][kind] = { ...old, _fetchedAt: old?._fetchedAt || null, _lastAttemptAt: currentTime, _status: "error", _error: "upstream_unavailable" };
    await persist(); // Save the budget BEFORE the request, even if the run fails later.
    await pause();
    try {
      const url = new URL("https://www.alphavantage.co/query");
      url.search = new URLSearchParams({ function: kind, symbol, apikey: apiKey }).toString();
      const response = await fetcher(url, { signal: AbortSignal.timeout(18000) });
      if (!response.ok) throw new Error(response.status === 429 ? "quota_exhausted" : "upstream_unavailable");
      const body = await response.json();
      const message = body?.Note || body?.Information || body?.["Error Message"] || "";
      if (/rate limit|call volume|25 requests|frequency/i.test(message)) throw new Error("quota_exhausted");
      const payload = publicPayload(kind, body, symbol);
      snapshot.symbols[symbol][kind] = { ...payload, _fetchedAt: currentTime, _lastAttemptAt: currentTime, _status: "ok" };
    } catch (error) {
      const reason = ["quota_exhausted", "invalid_data"].includes(error.message) ? error.message : "upstream_unavailable";
      snapshot.symbols[symbol][kind]._error = reason;
      if (reason === "quota_exhausted") snapshot.refresh.requests = 25;
    }
    await persist();
    return snapshot.symbols[symbol][kind]._status === "ok";
  };
  for (const symbol of SYMBOLS) {
    await request(symbol, "GLOBAL_QUOTE");
    if (!await request(symbol, "DIVIDENDS")) {
      if (!await request(symbol, "TIME_SERIES_MONTHLY_ADJUSTED")) await request(symbol, "OVERVIEW");
    }
  }
  return snapshot;
}

export async function run({ apiKey = process.env.ALPHA_VANTAGE_API_KEY, output = fileURLToPath(new URL("../data/market.json", import.meta.url)), ...options } = {}) {
  if (!String(apiKey || "").trim()) throw new Error("缺少 GitHub Secret ALPHA_VANTAGE_API_KEY；请在仓库 Settings → Secrets and variables → Actions 中配置。");
  let previous = {};
  try { previous = JSON.parse(await readFile(output, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("旧快照读取失败，已停止写入以保留原文件"); }
  await mkdir(dirname(output), { recursive: true });
  return updateSnapshot({ ...options, previous, apiKey, onProgress: async (snapshot) => {
    await writeFile(`${output}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
    await rename(`${output}.tmp`, output);
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(); console.log("公开行情快照检查完成（未读取任何用户持仓）"); }
  catch (error) {
    // Do not log arbitrary exceptions, request URLs or upstream messages.
    console.error(String(error.message).startsWith("缺少 GitHub Secret") ? "缺少 GitHub Secret ALPHA_VANTAGE_API_KEY，请在仓库 Actions Secrets 中配置。" : "行情快照更新失败，旧文件已保留；请检查配置与网络。");
    process.exitCode = 1;
  }
}
