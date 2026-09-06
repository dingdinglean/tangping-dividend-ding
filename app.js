import { configureMarketEndpoint, fetchUsdCnyRate, fetchAlphaQuote, fetchAlphaDividends, fetchAlphaMonthlyAdjustedDividends, fetchAlphaOverviewDividend, wait } from "./market-data.js?v=7.3";

const STORAGE_KEY = "tangping-dividend.v1";
const DELETE_BACKUP_KEY = "tangping-dividend.backup-before-delete";
const APP_VERSION = "v7.3";
const INCOME_YEAR = 2026;
const FX_REFRESH_MS = 12 * 60 * 60 * 1000;
const MARKET_REFRESH_MS = 18 * 60 * 60 * 1000;
const DIVIDEND_REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const AUTO_DIVIDEND_LOOKBACK_DAYS = 120;

const defaultMilestones = [
  { id: "milk-tea", icon: "☕", name: "奶茶自由", amountCny: 150 },
  { id: "utilities", icon: "⚡", name: "水电自由", amountCny: 400 },
  { id: "meals", icon: "🍽", name: "三餐自由", amountCny: 2500 },
  { id: "semi-retired", icon: "🌴", name: "半步退休", amountCny: 6000 },
  { id: "journey", icon: "🏔", name: "诗和远方", amountCny: 12000 },
  { id: "life", icon: "✨", name: "人生自由", amountCny: 20000 },
];

const defaultState = {
  version: 1,
  settings: {
    displayCurrency: "CNY",
    exchangeRate: 7.2,
    exchangeRateUpdatedAt: null,
    exchangeRateDate: null,
    exchangeRateSource: "手动备用值",
    monthlyGoal: 1000,
    alphaVantageApiKey: "",
    marketDataEndpoint: "",
    marketDataMode: "snapshot",
    autoRefresh: true,
    lastMarketRefreshAt: null,
    lastMarketRefreshMessage: "尚未连接行情",
    apiUsageDate: null,
    apiUsageCount: 0,
    lastBackupAt: null,
    freedomMilestones: defaultMilestones,
  },
  assets: [
    { id: crypto.randomUUID(), ticker: "QQQI", apiSymbol: "QQQI", name: "NEOS Nasdaq-100 High Income ETF", type: "ETF", frequency: "monthly", currentPrice: 0, priceUpdatedAt: null, priceTradingDay: null, priceSource: null, remoteDividends: [], dividendUpdatedAt: null, dividendSource: null, manualDividendYieldPercent: null, role: "高现金流" },
    { id: crypto.randomUUID(), ticker: "SPYI", apiSymbol: "SPYI", name: "NEOS S&P 500 High Income ETF", type: "ETF", frequency: "monthly", currentPrice: 0, priceUpdatedAt: null, priceTradingDay: null, priceSource: null, remoteDividends: [], dividendUpdatedAt: null, dividendSource: null, manualDividendYieldPercent: null, role: "高现金流" },
    { id: crypto.randomUUID(), ticker: "QNDX", apiSymbol: "QNDX", name: "State Street SPDR Portfolio Nasdaq 100 ETF", type: "ETF", frequency: "quarterly", currentPrice: 0, priceUpdatedAt: null, priceTradingDay: null, priceSource: null, remoteDividends: [], dividendUpdatedAt: null, dividendSource: null, manualDividendYieldPercent: null, role: "资产增长" },
    { id: crypto.randomUUID(), ticker: "SCHD", apiSymbol: "SCHD", name: "Schwab U.S. Dividend Equity ETF", type: "ETF", frequency: "quarterly", currentPrice: 0, priceUpdatedAt: null, priceTradingDay: null, priceSource: null, remoteDividends: [], dividendUpdatedAt: null, dividendSource: null, manualDividendYieldPercent: null, role: "股息增长" },
  ],
  transactions: [],
};

let stateNeedsMigration = false;
let storageReadError = false;
let state = loadState();
let currentTab = "home";
let modal = null;
let transactionType = "buy";
let calendarCursor = new Date();
let selectedDate = isoDate(new Date());
let toastTimer = null;
let refreshInProgress = false;
let lastAutoCheck = 0;

// Never replace an in-progress form when a background request completes.
function renderAfterSync() {
  if (modal || currentTab === "settings") return;
  render();
}

function loadState() {
  storageReadError = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return structuredClone(defaultState);
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.assets) || !Array.isArray(saved.transactions)) throw new Error("Unsupported data");
    stateNeedsMigration = saved.settings?.marketDataMode !== "snapshot" || saved.settings?.autoRefresh !== true || !Array.isArray(saved.settings?.freedomMilestones) || saved.settings.freedomMilestones.length !== defaultMilestones.length;
    const merged = { ...structuredClone(defaultState), ...saved, settings: { ...defaultState.settings, ...saved.settings } };
    merged.transactions = Array.isArray(saved.transactions) ? saved.transactions : [];
    merged.settings.freedomMilestones = normalizeMilestones(saved.settings?.freedomMilestones);
    // V7.3 keeps automatic public snapshots as the only in-app data mode.
    // Old advanced values stay stored for backwards-compatible exports, but are never sent.
    merged.settings.marketDataMode = "snapshot";
    merged.settings.autoRefresh = true;
    merged.assets = (saved.assets || defaultState.assets).map((asset) => ({
      apiSymbol: asset.ticker,
      priceUpdatedAt: null,
      priceTradingDay: null,
      priceSource: null,
      remoteDividends: [],
      dividendUpdatedAt: null,
      dividendSource: null,
      dividendDataQuality: null,
      dividendLastError: null,
      snapshotAnnualDividendPerShare: 0,
      snapshotDividendYield: 0,
      ...asset,
      apiSymbol: asset.apiSymbol || asset.ticker,
      remoteDividends: Array.isArray(asset.remoteDividends) ? asset.remoteDividends : [],
    }));
    return merged;
  } catch {
    storageReadError = true;
    stateNeedsMigration = false;
    return structuredClone(defaultState);
  }
}

function normalizeMilestones(savedMilestones) {
  if (!Array.isArray(savedMilestones)) return structuredClone(defaultMilestones);
  return defaultMilestones.map((fallback, index) => {
    const saved = savedMilestones.find((item) => item?.id === fallback.id) || savedMilestones[index] || {};
    return {
      id: fallback.id,
      icon: String(saved.icon || fallback.icon).trim().slice(0, 8) || fallback.icon,
      name: String(saved.name || fallback.name).trim().slice(0, 24) || fallback.name,
      amountCny: Math.max(1, number(saved.amountCny ?? saved.amount, fallback.amountCny)),
    };
  });
}

function saveState() {
  if (storageReadError) throw new Error("原有数据无法读取，已停止写入以保护原始数据；请先导出备份");
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function money(amountUsd, forceCurrency) {
  const currency = forceCurrency || state.settings.displayCurrency;
  const amount = currency === "CNY" ? amountUsd * number(state.settings.exchangeRate, 7.2) : amountUsd;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount || 0);
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isStale(timestamp, maxAgeMs) {
  if (!timestamp) return true;
  const value = new Date(timestamp).getTime();
  return !Number.isFinite(value) || Date.now() - value > maxAgeMs;
}

function formatUpdatedAt(timestamp, fallback = "尚未更新") {
  if (!timestamp) return fallback;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function todayKey() {
  return isoDate(new Date());
}

function resetApiCounterIfNeeded() {
  if (state.settings.apiUsageDate !== todayKey()) {
    state.settings.apiUsageDate = todayKey();
    state.settings.apiUsageCount = 0;
  }
}

function consumeApiRequest(count = 1) {
  if (getMarketEndpoint()) return;
  resetApiCounterIfNeeded();
  if (number(state.settings.apiUsageCount) + count > 25) throw new Error("今日 25 次请求预算已用完，明天自动重试");
  state.settings.apiUsageCount = number(state.settings.apiUsageCount) + count;
  saveState();
}

function getMarketEndpoint() {
  // V7.3's UI always persists snapshot mode. These branches only retain
  // backward-compatible import/export behavior for older saved settings.
  if (state.settings.marketDataMode === "direct") return "";
  if (state.settings.marketDataMode === "proxy") return state.settings.marketDataEndpoint || "";
  return "./data/market.json";
}

function getHistoricalRemoteDividends(asset) {
  const today = todayKey();
  return (asset.remoteDividends || [])
    .filter((row) => row.exDate && row.exDate <= today && number(row.amount) >= 0)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
}

function getTtmDividendPerShare(asset) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 365);
  const cutoffDate = isoDate(cutoff);
  const value = getHistoricalRemoteDividends(asset)
    .filter((row) => row.exDate >= cutoffDate)
    .reduce((sum, row) => sum + number(row.amount), 0);
  if (value > 0) return value;
  const snapshotPerShare = number(asset.snapshotAnnualDividendPerShare);
  if (snapshotPerShare > 0) return snapshotPerShare;
  const snapshotYield = number(asset.snapshotDividendYield);
  return snapshotYield > 0 && number(asset.currentPrice) > 0 ? snapshotYield * number(asset.currentPrice) : 0;
}

function getForwardDividendPerShare(asset) {
  const rows = getHistoricalRemoteDividends(asset);
  if (!rows.length) {
    const snapshotPerShare = number(asset.snapshotAnnualDividendPerShare);
    if (snapshotPerShare > 0) return snapshotPerShare;
    const snapshotYield = number(asset.snapshotDividendYield);
    return snapshotYield > 0 && number(asset.currentPrice) > 0 ? snapshotYield * number(asset.currentPrice) : 0;
  }
  if (asset.frequency === "irregular") return getTtmDividendPerShare(asset);
  const count = asset.frequency === "monthly" ? 3 : asset.frequency === "quarterly" ? 4 : asset.frequency === "semiannual" ? 2 : 1;
  const multiplier = asset.frequency === "monthly" ? 12 : asset.frequency === "quarterly" ? 4 : asset.frequency === "semiannual" ? 2 : 1;
  const sample = rows.slice(0, count);
  const average = sample.reduce((sum, row) => sum + number(row.amount), 0) / sample.length;
  return average * multiplier;
}

function getNextDeclaredDividend(asset) {
  const today = todayKey();
  return (asset.remoteDividends || [])
    .filter((row) => row.canAutoCreate !== false && (row.paymentDate || row.exDate) >= today && number(row.amount) > 0)
    .sort((a, b) => (a.paymentDate || a.exDate).localeCompare(b.paymentDate || b.exDate))[0] || null;
}

function mergeDividendRows(existingRows, fallbackRows) {
  const exactByMonth = new Set((existingRows || []).filter((row) => row.canAutoCreate !== false).map((row) => String(row.exDate || "").slice(0, 7)));
  const fallback = (fallbackRows || []).filter((row) => !exactByMonth.has(String(row.exDate || "").slice(0, 7)));
  return [...(existingRows || []).filter((row) => row.canAutoCreate !== false), ...fallback]
    .sort((a, b) => String(b.exDate || "").localeCompare(String(a.exDate || "")));
}

function getObservedNetFactor(item) {
  const rows = state.transactions
    .filter((tx) => tx.assetId === item.asset.id && tx.type === "dividend" && tx.status === "received" && number(tx.grossDividend) > 0 && number(tx.netDividend) >= 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);
  if (!rows.length) return 1;
  const ratios = rows.map((tx) => Math.min(1, Math.max(0, number(tx.netDividend) / number(tx.grossDividend))));
  return ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getAsset(assetId) {
  return state.assets.find((asset) => asset.id === assetId);
}

function getSharesBeforeExDate(assetId, exDate) {
  if (!exDate) return 0;
  let shares = 0;
  [...state.transactions]
    .filter((tx) => tx.assetId === assetId && ["buy", "sell"].includes(tx.type) && tx.date && tx.date < exDate)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || ""))
    .forEach((tx) => {
      if (tx.type === "buy") shares += number(tx.shares);
      if (tx.type === "sell") shares -= Math.min(number(tx.shares), Math.max(0, shares));
    });
  return Math.max(0, shares);
}

function getRemoteDividendKey(asset, row) {
  return `alpha:${asset.apiSymbol || asset.ticker}:${row.exDate}`;
}

function syncDeclaredDividendTransactions(asset) {
  if (!getAsset(asset.id)) return { created: 0, updated: 0 };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - AUTO_DIVIDEND_LOOKBACK_DAYS);
  const cutoffDate = isoDate(cutoff);
  const netFactor = getObservedNetFactor({ asset });
  let created = 0;
  let updated = 0;

  (asset.remoteDividends || []).forEach((row) => {
    if (row.canAutoCreate === false) return;
    const eventDate = row.paymentDate || row.exDate;
    if (!row.exDate || !eventDate || eventDate < cutoffDate || number(row.amount) <= 0) return;

    const shareCount = getSharesBeforeExDate(asset.id, row.exDate);
    if (shareCount <= 0) return;

    const sourceDividendKey = getRemoteDividendKey(asset, row);
    const grossDividend = shareCount * number(row.amount);
    const estimatedNetDividend = grossDividend * netFactor;
    let existing = state.transactions.find((tx) => tx.sourceDividendKey === sourceDividendKey);

    if (!existing) {
      existing = state.transactions.find((tx) =>
        tx.assetId === asset.id &&
        tx.type === "dividend" &&
        (tx.exDate === row.exDate || (!tx.exDate && tx.date === eventDate)) &&
        Math.abs(number(tx.perShare) - number(row.amount)) < 0.000001
      );
    }

    const remoteFields = {
      sourceDividendKey,
      source: "Alpha Vantage Dividends",
      isAutoGenerated: true,
      exDate: row.exDate,
      declarationDate: row.declarationDate || "",
      recordDate: row.recordDate || "",
      paymentDate: row.paymentDate || "",
      shareCount,
      perShare: number(row.amount),
      grossDividend,
    };

    if (existing) {
      const sourceFields = {
        sourceDividendKey,
        source: "Alpha Vantage Dividends",
        isAutoGenerated: true,
        exDate: row.exDate,
        declarationDate: row.declarationDate || "",
        recordDate: row.recordDate || "",
        paymentDate: row.paymentDate || "",
      };
      if (existing.status === "received") {
        // 已确认的数据以券商实际入账为准，只补充远程日期与来源，不覆盖金额。
        Object.assign(existing, sourceFields);
      } else {
        Object.assign(existing, remoteFields, {
          date: eventDate,
          status: "announced",
          taxAndFees: Math.max(0, grossDividend - estimatedNetDividend),
          netDividend: estimatedNetDividend,
          isEstimatedNet: true,
          note: existing.note || "由动态股息数据自动生成，到账后请确认",
          updatedAt: new Date().toISOString(),
        });
      }
      updated += 1;
      return;
    }

    state.transactions.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      assetId: asset.id,
      type: "dividend",
      date: eventDate,
      status: "announced",
      taxAndFees: Math.max(0, grossDividend - estimatedNetDividend),
      netDividend: estimatedNetDividend,
      isEstimatedNet: true,
      note: "由动态股息数据自动生成，到账后请确认",
      ...remoteFields,
    });
    created += 1;
  });

  return { created, updated };
}

function getPendingDividendTransactions() {
  const today = todayKey();
  return state.transactions
    .filter((tx) => tx.type === "dividend" && tx.status === "announced" && (tx.paymentDate || tx.date) <= today)
    .sort((a, b) => (a.paymentDate || a.date).localeCompare(b.paymentDate || b.date));
}

function getManualDividendYield(asset) {
  const raw = asset?.manualDividendYieldPercent;
  if (raw === null || raw === undefined || raw === "") return null;
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0) return null;
  return percent / 100;
}

function calculatePortfolio() {
  const map = new Map(state.assets.map((asset) => [asset.id, {
    asset,
    shares: 0,
    cost: 0,
    receivedDividends: 0,
    announcedDividends: 0,
    forecastDividends: 0,
    dividendRecords: [],
  }]));

  [...state.transactions]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || ""))
    .forEach((tx) => {
      const item = map.get(tx.assetId);
      if (!item) return;
      if (tx.type === "buy") {
        item.cost += number(tx.shares) * number(tx.price) + number(tx.fees);
        item.shares += number(tx.shares);
      }
      if (tx.type === "sell" && item.shares > 0) {
        const qty = Math.min(number(tx.shares), item.shares);
        const avg = item.cost / item.shares;
        item.cost = Math.max(0, item.cost - avg * qty);
        item.shares = Math.max(0, item.shares - qty);
      }
      if (tx.type === "dividend") {
        const net = number(tx.netDividend);
        if (tx.status === "received") item.receivedDividends += net;
        if (tx.status === "announced") item.announcedDividends += net;
        if (tx.status === "forecast") item.forecastDividends += net;
        if (number(tx.shareCount) > 0 && ["received", "announced"].includes(tx.status)) {
          item.dividendRecords.push({ date: tx.date, perShareNet: net / number(tx.shareCount) });
        }
      }
    });

  const positions = [...map.values()].map((item) => {
    const marketValue = item.shares * number(item.asset.currentPrice);
    const pnl = marketValue - item.cost;
    const ttmPerShare = getTtmDividendPerShare(item.asset);
    const forwardPerShare = getForwardDividendPerShare(item.asset);
    const currentPrice = number(item.asset.currentPrice);
    const ttmYield = currentPrice > 0 ? ttmPerShare / currentPrice : 0;
    const forwardYield = currentPrice > 0 ? forwardPerShare / currentPrice : 0;
    const manualYield = getManualDividendYield(item.asset);
    const dividendYield = manualYield !== null ? manualYield : (forwardYield > 0 ? forwardYield : ttmYield);
    const annualForecast = manualYield !== null
      ? marketValue * manualYield * getObservedNetFactor(item)
      : estimateAnnualDividend(item, forwardPerShare || ttmPerShare);
    return {
      ...item,
      marketValue,
      pnl,
      annualForecast,
      ttmPerShare,
      forwardPerShare,
      ttmYield,
      forwardYield,
      manualYield,
      dividendYield,
      currentYield: marketValue > 0 ? annualForecast / marketValue : 0,
      yieldOnCost: item.cost > 0 ? annualForecast / item.cost : 0,
      nextDividend: getNextDeclaredDividend(item.asset),
      hasDividendEstimate: item.shares <= 0 || manualYield !== null || forwardPerShare > 0 || ttmPerShare > 0 || item.dividendRecords.length > 0,
    };
  });

  const totals = positions.reduce((acc, item) => {
    acc.marketValue += item.marketValue;
    acc.cost += item.cost;
    acc.pnl += item.pnl;
    acc.received += item.receivedDividends;
    acc.annualForecast += item.annualForecast;
    if (item.shares > 0) {
      acc.heldCount += 1;
      if (number(item.asset.currentPrice) > 0) acc.priceCoveredCount += 1;
      if (item.hasDividendEstimate) acc.dividendCoveredCount += 1;
    }
    return acc;
  }, { marketValue: 0, cost: 0, pnl: 0, received: 0, annualForecast: 0, heldCount: 0, dividendCoveredCount: 0, priceCoveredCount: 0 });
  totals.dividendCoverageComplete = totals.heldCount > 0 && totals.dividendCoveredCount === totals.heldCount;
  totals.priceCoverageComplete = totals.heldCount === totals.priceCoveredCount;

  return { positions, totals };
}

function estimateAnnualDividend(item, remoteForwardPerShare = 0) {
  if (item.shares <= 0) return 0;
  if (remoteForwardPerShare > 0) {
    return remoteForwardPerShare * item.shares * getObservedNetFactor(item);
  }
  const records = [...item.dividendRecords].sort((a, b) => b.date.localeCompare(a.date));
  if (!records.length) return 0;
  const frequency = item.asset.frequency;
  const count = frequency === "monthly" ? 3 : frequency === "quarterly" ? 4 : frequency === "semiannual" ? 2 : 1;
  const multiplier = frequency === "monthly" ? 12 : frequency === "quarterly" ? 4 : frequency === "semiannual" ? 2 : 1;
  const sample = records.slice(0, count);
  const avgPerShare = sample.reduce((sum, row) => sum + row.perShareNet, 0) / sample.length;
  return avgPerShare * item.shares * multiplier;
}

function monthlyIncomeData(year) {
  const received = Array(12).fill(0);
  const announced = Array(12).fill(0);
  const forecast = Array(12).fill(0);
  state.transactions.forEach((tx) => {
    const date = String(tx.date || "");
    if (tx.type !== "dividend" || !date.startsWith(String(year))) return;
    const month = Number(date.slice(5, 7)) - 1;
    if (month < 0 || month > 11) return;
    if (tx.status === "received") received[month] += number(tx.netDividend);
    if (tx.status === "announced") announced[month] += number(tx.netDividend);
    if (tx.status === "forecast") forecast[month] += number(tx.netDividend);
  });
  // Derived projections are never written to the user's transaction ledger.
  const now = new Date();
  calculatePortfolio().positions.forEach((item) => {
    if (item.shares <= 0 || item.annualForecast <= 0 || item.asset.frequency === "irregular") return;
    const interval = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12 }[item.asset.frequency];
    if (!interval) return;
    const dates = [...(item.asset.remoteDividends || []).map((row) => row.paymentDate || row.exDate),
      ...item.dividendRecords.map((row) => row.date)].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "")).sort().reverse();
    // Without payment history, don't invent a quarterly/annual schedule.
    if (interval > 1 && !dates.length) return;
    const anchor = dates.length ? Number(dates[0].slice(5, 7)) - 1 : 0;
    for (let month = 0; month < 12; month += 1) {
      if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth())) continue;
      if (((month - anchor) % interval + interval) % interval !== 0) continue;
      const key = `${year}-${String(month + 1).padStart(2, "0")}`;
      const hasRecord = state.transactions.some((tx) => tx.assetId === item.asset.id && tx.type === "dividend" && String(tx.date).startsWith(key) && ["received", "announced", "forecast"].includes(tx.status));
      if (!hasRecord) forecast[month] += item.annualForecast * interval / 12;
    }
  });
  return { received, announced, forecast };
}

function getMonthlyPassiveIncomeUsd(totals) {
  return Math.max(0, totals.annualForecast / 12);
}

function displayCnyAmount(amountCny) {
  if (state.settings.displayCurrency === "CNY") {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 2 }).format(amountCny || 0);
  }
  return money(number(amountCny) / number(state.settings.exchangeRate, 7.2), "USD");
}

function getFreedomStatus(monthlyIncomeCny) {
  const milestones = normalizeMilestones(state.settings.freedomMilestones)
    .map((item) => ({ ...item, unlocked: monthlyIncomeCny >= item.amountCny }))
    .sort((a, b) => a.amountCny - b.amountCny);
  const unlocked = milestones.filter((item) => item.unlocked);
  const current = unlocked.at(-1) || null;
  const next = milestones.find((item) => !item.unlocked) || null;
  const rangeStart = current?.amountCny || 0;
  const progress = next
    ? Math.min(100, Math.max(0, (monthlyIncomeCny - rangeStart) / Math.max(1, next.amountCny - rangeStart) * 100))
    : 100;
  return { milestones, current, next, progress };
}

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <main class="app-shell">
      ${renderTopbar()}
      <section class="tab-page ${currentTab}-page">
        ${storageReadError ? '<section class="card storage-warning"><p>原有数据暂时无法读取，已停止写入，未清空原始内容。</p><button class="btn" data-action="export-data">导出原始备份</button></section>' : ""}
        ${currentTab === "home" ? renderHome() : ""}
        ${currentTab === "portfolio" ? renderPortfolio() : ""}
        ${currentTab === "calendar" ? renderCalendar() : ""}
        ${currentTab === "settings" ? renderSettings() : ""}
      </section>
    </main>
    ${renderBottomNav()}
    ${["home", "portfolio", "calendar"].includes(currentTab) ? '<button class="floating-add" data-action="open-add" aria-label="新增记录">＋</button>' : ""}
    ${modal ? renderModal() : ""}
  `;
  bindEvents();
}

function renderTopbar() {
  const titles = {
    home: ["躺平股息", "今天离海边咖啡又近一点"],
    portfolio: ["投资组合", "只记真正长期持有的几只"],
    calendar: ["股息日历", "到账日比上班日更值得记"],
    settings: ["设置", "偏好与本机数据"],
  };
  const [title, sub] = titles[currentTab];
  return `
    <header class="topbar">
      <div class="brand">
        <div class="logo">☕</div>
        <div><h1>${title}</h1><p>${sub}</p></div>
      </div>
      <button class="icon-btn" data-action="toggle-currency" title="切换人民币/美元">${state.settings.displayCurrency === "CNY" ? "¥" : "$"}</button>
    </header>
  `;
}

function marketStatusText() {
  const staleCount = state.assets.filter((asset) => isStale(asset.priceUpdatedAt, MARKET_REFRESH_MS) || isStale(asset.dividendUpdatedAt, DIVIDEND_REFRESH_MS)).length;
  return !navigator.onLine ? "行情离线，继续使用上次数据"
    : staleCount ? "行情暂未更新，继续使用上次数据"
    : `行情 ${formatUpdatedAt(state.settings.lastMarketRefreshAt)}`;
}

function renderMarketCaption() {
  return `<p class="market-caption">${escapeHtml(marketStatusText())}</p>`;
}

function renderHome() {
  const { totals } = calculatePortfolio();
  const year = INCOME_YEAR;
  const chart = monthlyIncomeData(year);
  const monthExpected = getMonthlyPassiveIncomeUsd(totals);
  const monthlyIncomeCny = monthExpected * number(state.settings.exchangeRate, 7.2);
  const monthlyGoalUsd = state.settings.monthlyGoal / number(state.settings.exchangeRate, 7.2);
  const currentYield = totals.marketValue > 0 ? totals.annualForecast / totals.marketValue : 0;
  const yieldOnCost = totals.cost > 0 ? totals.annualForecast / totals.cost : 0;

  if (!totals.heldCount) return `
    <section class="card hero income-hero empty-home">
      <div class="eyebrow">预计每月被动收入</div>
      <div class="hero-value">暂无持仓</div>
      <p>从第一笔持仓开始，自动汇总收益、里程碑和年度趋势。</p>
      <button class="btn primary" data-action="open-asset">添加第一笔持仓</button>
    </section>
    ${renderMarketCaption()}
  `;

  return `
    <section class="card hero income-hero">
      <div class="hero-row">
        <div>
          <div class="eyebrow">预计每月被动收入 · ${state.settings.displayCurrency}</div>
          <div class="hero-value">${!totals.dividendCoveredCount ? "待更新" : money(monthExpected)}</div>
          <div class="hero-sub">当前持仓预计年股息 ÷ 12${!totals.dividendCoverageComplete ? " · 部分标的待更新" : ""}</div>
        </div>
        <div class="hero-goal"><div class="eyebrow">月目标</div><strong>${new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(state.settings.monthlyGoal)}</strong></div>
      </div>
      <div class="income-facts"><div><span>本月实际到账</span><strong>${money(state.transactions.filter((tx) => tx.type === "dividend" && tx.status === "received" && String(tx.date).startsWith(todayKey().slice(0, 7))).reduce((sum, tx) => sum + number(tx.netDividend), 0))}</strong></div><div><span>累计已收股息</span><strong>${money(totals.received)}</strong></div></div>
    </section>

    <div class="grid-2">
      <div class="metric-card">
        <div class="metric-label">价格股息率</div>
        <div class="metric-value">${totals.marketValue > 0 && totals.dividendCoverageComplete && totals.priceCoverageComplete ? `${(currentYield * 100).toFixed(2)}%` : "待更新"}</div>
        <div class="metric-foot">按当前市值计算</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">成本股息率</div>
        <div class="metric-value">${totals.cost > 0 && totals.dividendCoverageComplete ? `${(yieldOnCost * 100).toFixed(2)}%` : "待更新"}</div>
        <div class="metric-foot">按持仓成本计算</div>
      </div>
    </div>

    ${renderFreedomMilestones(monthlyIncomeCny)}
    ${renderIncomeChart(chart, monthlyGoalUsd, year)}
    ${renderMarketCaption()}
  `;
}

function renderFreedomMilestones(monthlyIncomeCny) {
  const { milestones, current, next, progress } = getFreedomStatus(monthlyIncomeCny);
  return `
    <section class="card freedom-card">
      <div class="card-heading"><div><span class="eyebrow">自由里程碑</span><h2>${current ? `${escapeHtml(current.icon)} ${escapeHtml(current.name)}` : "从第一步开始"}</h2></div><strong>${displayCnyAmount(monthlyIncomeCny)}<small>/月</small></strong></div>
      <div class="freedom-next">${next ? `${escapeHtml(next.icon)} ${escapeHtml(next.name)} · ${displayCnyAmount(monthlyIncomeCny)} / ${displayCnyAmount(next.amountCny)}` : "六个里程碑已全部解锁"}</div>
      <div class="progress-track freedom-progress"><div class="progress-fill" style="width:${progress}%"></div></div>
    </section>`;
}

function renderPendingDividends(rows) {
  if (!rows.length) return "";
  return `
    <div class="section-title"><h2>待确认到账</h2><small>${rows.length} 笔</small></div>
    <section class="card pending-list">
      ${rows.map((tx) => {
        const asset = getAsset(tx.assetId);
        return `<div class="pending-dividend">
          <div class="pending-main">
            <div class="pending-title"><strong>${escapeHtml(asset?.ticker || "未知标的")}</strong><span class="tag warn">待确认</span></div>
            <p>计划到账 ${escapeHtml(tx.paymentDate || tx.date)} · 除息 ${escapeHtml(tx.exDate || "—")}</p>
            <p>$${number(tx.perShare).toFixed(4)}/股 × ${number(tx.shareCount).toFixed(4).replace(/\.0+$/, "")} 股 · 税前 ${money(number(tx.grossDividend), "USD")}</p>
          </div>
          <div class="pending-side"><strong>${money(number(tx.netDividend), "USD")}</strong><small>预计净到账</small><button class="btn yellow compact" data-action="confirm-dividend" data-id="${tx.id}">确认到账</button></div>
        </div>`;
      }).join("")}
    </section>`;
}

function renderIncomeChart(chart, goalUsd, year = INCOME_YEAR) {
  const plotHeight = 96;
  const values = chart.received.map((v, i) => v + chart.announced[i] + chart.forecast[i]);
  const max = Math.max(...values, 1) * 1.12;
  const annualTotal = values.reduce((sum, value) => sum + value, 0);
  const axisLabel = (value) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value * (state.settings.displayCurrency === "CNY" ? number(state.settings.exchangeRate, 7.2) : 1));
  const heightFor = (value) => value > 0 ? Math.max(3, value / max * plotHeight) : 0;
  const bars = values.map((_, i) => {
    const r = heightFor(chart.received[i]);
    const a = heightFor(chart.announced[i]);
    const f = heightFor(chart.forecast[i]);
    const total = values[i];
    return `<div class="bar-group" aria-label="${i + 1} 月 ${money(total)}"><div class="bar-stack ${total > 0 ? "has-value" : ""}"><div class="bar received" style="height:${r}px"></div><div class="bar announced" style="height:${a}px"></div><div class="bar forecast" style="height:${f}px"></div></div><div class="month-label">${i + 1}月</div></div>`;
  }).join("");
  return `
    <section class="card chart-card">
      <div class="chart-head"><div class="eyebrow">${year} 年股息趋势</div><strong>${money(annualTotal)}</strong></div>
      <div class="chart-plot"><div class="chart-grid-lines">${[1, 2 / 3, 1 / 3, 0].map((ratio) => `<i><span>${axisLabel(max * ratio)}</span></i>`).join("")}</div><div class="chart-bars">${bars}</div></div>
      <div class="legend"><span class="l1">已收到</span><span class="l2">已宣布</span><span class="l3">预测</span></div>
    </section>
  `;
}

function renderPortfolio() {
  const { positions, totals } = calculatePortfolio();
  return `
    <section class="portfolio-summary summary-strip">
      <div class="summary-item"><strong>${totals.priceCoverageComplete ? money(totals.marketValue) : "待更新"}</strong><span>总市值</span></div>
      <div class="summary-item"><strong>${money(totals.received)}</strong><span>累计股息</span></div>
      <div class="summary-item"><strong>${money(totals.annualForecast / 12)}</strong><span>预计月均</span></div>
    </section>
    <div class="section-title page-section-title"><h2>我的标的</h2><small>${positions.length} 只 · 点按查看详情</small></div>
    <section class="portfolio-list" aria-label="持仓列表">
      ${positions.length ? positions.map(renderAssetCard).join("") : '<section class="card empty"><div class="big">☕</div><strong>暂无持仓</strong><p>添加第一笔持仓，开始记录你的股息计划。</p><button class="btn primary" data-action="open-asset">添加第一笔持仓</button></section>'}
    </section>
  `;
}

function renderAssetCard(item) {
  const asset = item.asset;
  const priceFresh = !isStale(asset.priceUpdatedAt, MARKET_REFRESH_MS * 2);
  return `
    <article class="card asset-card asset-card-compact" data-asset-card="${asset.id}" data-action="asset-detail" data-id="${asset.id}" role="button" tabindex="0" aria-label="查看 ${escapeHtml(asset.ticker)} 详情">
      <div class="asset-head">
        <div class="asset-title"><h3>${escapeHtml(asset.name)}</h3><div class="ticker-row"><strong>${escapeHtml(asset.ticker)}</strong><span class="tag">${escapeHtml(asset.role)}</span></div></div>
        <div class="asset-value"><strong>${asset.currentPrice > 0 ? money(item.marketValue) : "待更新"}</strong><span>${item.shares.toFixed(4).replace(/\.0+$/, "")} 股</span></div>
      </div>
      <div class="asset-compact-grid">
        <div><label>价格</label><strong>${asset.currentPrice > 0 ? money(number(asset.currentPrice), "USD") : "—"}</strong></div>
        <div><label>股息率</label><strong>${item.manualYield !== null || item.dividendYield > 0 ? `${(item.dividendYield * 100).toFixed(2)}%` : "待更新"}</strong></div>
        <div><label>预计年股息</label><strong>${item.hasDividendEstimate ? money(item.annualForecast) : "—"}</strong></div>
      </div>
      <div class="asset-card-foot"><span class="status-dot ${priceFresh ? "fresh" : "stale"}"></span><span>${asset.priceLastError ? "行情暂不可用，保留旧值" : "点按查看持仓、收益与分红详情"}</span><b>›</b></div>
    </article>
  `;
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  const events = state.transactions.filter((tx) => tx.date === selectedDate);

  return `
    <section class="calendar-month card">
      <div class="calendar-head">
        <div><div class="year">${year}</div><div class="month">${month + 1}月</div></div>
        <div class="calendar-actions"><button class="icon-btn" data-action="prev-month" aria-label="上个月">‹</button><button class="icon-btn" data-action="next-month" aria-label="下个月">›</button></div>
      </div>
      <section class="calendar-grid">
        ${["周日","周一","周二","周三","周四","周五","周六"].map((w) => `<div class="weekday">${w}</div>`).join("")}
        ${days.map((date) => renderDay(date, month)).join("")}
      </section>
    </section>
    <section class="calendar-events-panel card">
      <div class="calendar-events-head"><div><span class="eyebrow">所选日期事件</span><h2>${selectedDate}</h2></div><small>${events.length} 条记录</small></div>
      <div class="calendar-events-scroll">${events.length ? events.map(renderEvent).join("") : `<div class="empty calendar-empty">这一天没有交易或股息记录</div>`}</div>
    </section>
  `;
}

function renderDay(date, activeMonth) {
  const dateString = isoDate(date);
  const events = state.transactions.filter((tx) => tx.date === dateString).slice(0, 3);
  const isToday = dateString === isoDate(new Date());
  const selected = dateString === selectedDate;
  return `<button class="day ${date.getMonth() !== activeMonth ? "muted" : ""} ${isToday ? "today" : ""} ${selected ? "selected" : ""}" data-action="select-date" data-date="${dateString}">${date.getDate()}<span class="dots">${events.map((event) => `<i class="dot ${event.type === "dividend" ? event.status : event.type}"></i>`).join("")}</span></button>`;
}

function renderEvent(tx) {
  const asset = getAsset(tx.assetId);
  const due = tx.type === "dividend" && tx.status === "announced" && (tx.paymentDate || tx.date) <= todayKey();
  const title = tx.type === "buy" ? "买入" : tx.type === "sell" ? "卖出" : tx.status === "received" ? "股息到账" : due ? "待确认到账" : tx.status === "announced" ? "已宣布股息" : "预测股息";
  const amount = tx.type === "dividend" ? money(number(tx.netDividend), "USD") : `${number(tx.shares)} 股 × ${money(number(tx.price), "USD")}`;
  const detail = tx.type === "dividend" && tx.exDate
    ? `除息 ${tx.exDate}${tx.paymentDate ? ` · 计划到账 ${tx.paymentDate}` : ""}`
    : tx.note || "无备注";
  return `<div class="event-item"><div><h4>${escapeHtml(asset?.ticker || "未知标的")} · ${title}</h4><p>${escapeHtml(detail)}</p></div><div class="event-actions"><strong>${amount}</strong>${due ? `<button class="btn yellow compact" data-action="confirm-dividend" data-id="${tx.id}">确认</button>` : ""}</div></div>`;
}

function renderSettings() {
  const backupText = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt).toLocaleString("zh-CN") : "尚未备份";
  return `
    <section class="card settings-menu">
      <button class="settings-menu-row" data-action="open-display-settings"><span><b>显示货币</b><small>${state.settings.displayCurrency === "CNY" ? "人民币 CNY" : "美元 USD"}</small></span><em>›</em></button>
      <button class="settings-menu-row" data-action="open-goal-settings"><span><b>月收入目标</b><small>¥${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(state.settings.monthlyGoal)}/月</small></span><em>›</em></button>
      <button class="settings-menu-row" data-action="open-milestone-settings"><span><b>自由里程碑</b><small>6 个等级 · 人民币/月</small></span><em>›</em></button>
      <button class="settings-menu-row" data-action="export-data"><span><b>导出备份</b><small>${backupText}</small></span><em>›</em></button>
      <button class="settings-menu-row" data-action="import-data"><span><b>导入备份</b><small>从 JSON 恢复本机数据</small></span><em>›</em></button>
      <button class="settings-menu-row danger-row" data-action="reset-data"><span><b>清空数据</b><small>仅清空当前设备数据</small></span><em>›</em></button>
    </section>
    <input class="file-input" id="importFile" type="file" accept="application/json" />

    <section class="card settings-about">
      <div><b>躺平股息</b><small>行情自动更新，实际到账需本人确认</small></div>
      <small>${escapeHtml(marketStatusText())}</small>
    </section>
  `;
}

function renderBottomNav() {
  const items = [
    ["home", "⌂", "首页"],
    ["portfolio", "◔", "持仓"],
    ["calendar", "▦", "日历"],
    ["settings", "⚙", "设置"],
  ];
  return `<nav class="bottom-nav" aria-label="主导航">${items.map(([tab, icon, label]) => `<button class="nav-btn ${currentTab === tab ? "active" : ""}" data-tab="${tab}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span></button>`).join("")}</nav>`;
}

function renderModal() {
  if (modal.type === "transaction") return renderTransactionModal();
  if (modal.type === "asset") return renderAssetModal(modal.assetId);
  if (modal.type === "price") return renderPriceModal(modal.assetId);
  if (modal.type === "confirm-dividend") return renderConfirmDividendModal(modal.transactionId);
  if (modal.type === "display-settings") return renderDisplaySettingsModal();
  if (modal.type === "goal-settings") return renderGoalSettingsModal();
  if (modal.type === "milestone-settings") return renderMilestoneSettingsModal();
  return "";
}

function renderTransactionModal() {
  const defaultAssetId = modal.assetId || state.assets[0]?.id || "";
  const asset = getAsset(defaultAssetId);
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>新增记录</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <div class="type-picker">${[["buy","买入"],["sell","卖出"],["dividend","股息"]].map(([type,label]) => `<button class="${transactionType === type ? "active" : ""}" data-action="pick-type" data-type="${type}">${label}</button>`).join("")}</div>
    <form id="transactionForm" class="form-grid">
      <div class="form-row"><label>标的</label><select name="assetId" id="txAsset">${state.assets.map((item) => `<option value="${item.id}" ${item.id === defaultAssetId ? "selected" : ""}>${escapeHtml(item.ticker)} · ${escapeHtml(item.name)}</option>`).join("")}</select></div>
      <div class="form-row"><label>日期</label><input class="input" type="date" name="date" value="${isoDate(new Date())}" required /></div>
      ${transactionType === "dividend" ? renderDividendFields(asset) : renderTradeFields()}
      <div class="form-row"><label>备注</label><textarea name="note" placeholder="可不填"></textarea></div>
      <button class="btn primary full" type="submit">保存记录</button>
    </form>
  </div></div>`;
}

function renderTradeFields() {
  return `
    <div class="form-row"><label>股数</label><input class="input" type="number" name="shares" step="0.0001" min="0.0001" required /></div>
    <div class="form-row"><label>成交单价（USD）</label><input class="input" type="number" name="price" step="0.0001" min="0" required /></div>
    <div class="form-row"><label>手续费（USD）</label><input class="input" type="number" name="fees" step="0.01" min="0" value="0" /></div>
  `;
}

function renderDividendFields(asset) {
  const portfolio = calculatePortfolio().positions.find((item) => item.asset.id === asset?.id);
  const shares = portfolio?.shares || 0;
  return `
    <div class="form-row"><label>状态</label><select name="status"><option value="received">已收到</option><option value="announced">已宣布</option><option value="forecast">预测</option></select></div>
    <div class="form-row"><label>对应股数</label><input class="input" type="number" name="shareCount" step="0.0001" min="0" value="${shares || ""}" /></div>
    <div class="form-row"><label>每股税前股息（USD，可选）</label><input class="input" type="number" name="perShare" step="0.000001" min="0" /></div>
    <div class="form-row"><label>税前股息（USD）</label><input class="input" type="number" name="grossDividend" step="0.01" min="0" /></div>
    <div class="form-row"><label>预扣税与费用（USD）</label><input class="input" type="number" name="taxAndFees" step="0.01" min="0" value="0" /></div>
    <div class="form-row"><label>实际到账净股息（USD）</label><input class="input" type="number" name="netDividend" step="0.01" min="0" required /></div>
  `;
}

function renderAssetModal(assetId) {
  const asset = assetId ? getAsset(assetId) : null;
  const item = asset ? calculatePortfolio().positions.find((position) => position.asset.id === asset.id) : null;
  const next = item?.nextDividend;
  const detail = item ? `
    <section class="asset-detail-summary">
      <div><span>市值</span><strong>${asset.currentPrice > 0 ? money(item.marketValue) : "待更新"}</strong></div>
      <div><span>成本</span><strong>${money(item.cost)}</strong></div>
      <div><span>浮动盈亏</span><strong class="${asset.currentPrice > 0 ? (item.pnl >= 0 ? "positive" : "negative") : ""}">${asset.currentPrice > 0 ? money(item.pnl) : "待更新"}</strong></div>
      <div><span>已收股息</span><strong>${money(item.receivedDividends)}</strong></div>
      <div><span>预计年股息</span><strong>${item.hasDividendEstimate ? money(item.annualForecast) : "—"}</strong></div>
      <div><span>下次分红</span><strong>${next ? escapeHtml(next.paymentDate || next.exDate) : "暂无已宣布记录"}</strong></div>
    </section>
    <div class="btn-row modal-quick-actions"><button class="btn" data-action="refresh-asset" data-id="${asset.id}" ${refreshInProgress ? "disabled" : ""}>更新行情</button><button class="btn" data-action="quick-price" data-id="${asset.id}">手动价格</button></div>` : "";
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>${asset ? "编辑标的" : "添加标的"}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    ${detail}
    <form id="assetForm" class="form-grid">
      <input type="hidden" name="assetId" value="${asset?.id || ""}" />
      <div class="form-row"><label>股票代码</label><input class="input" name="ticker" maxlength="12" value="${escapeHtml(asset?.ticker || "")}" placeholder="例如 QNDX" required /></div>
      <div class="form-row"><label>名称</label><input class="input" name="name" value="${escapeHtml(asset?.name || "")}" required /></div>
      <div class="form-row"><label>手动股息率（%）</label><input class="input" name="manualDividendYieldPercent" type="number" step="0.01" min="0" value="${asset?.manualDividendYieldPercent ?? ""}" placeholder="留空自动更新" /></div>
      <details class="advanced-settings">
        <summary>更多设置</summary>
        <div class="form-grid advanced-grid">
          <div class="form-row"><label>行情代码</label><input class="input" name="apiSymbol" maxlength="24" value="${escapeHtml(asset?.apiSymbol || asset?.ticker || "")}" /></div>
          <div class="form-row"><label>类型</label><select name="assetType"><option ${asset?.type === "ETF" ? "selected" : ""}>ETF</option><option ${asset?.type === "Stock" ? "selected" : ""}>Stock</option><option ${asset?.type === "ADR" ? "selected" : ""}>ADR</option><option ${asset?.type === "Other" ? "selected" : ""}>Other</option></select></div>
          <div class="form-row"><label>分红频率</label><select name="frequency"><option value="monthly" ${asset?.frequency === "monthly" ? "selected" : ""}>每月</option><option value="quarterly" ${asset?.frequency === "quarterly" ? "selected" : ""}>每季度</option><option value="semiannual" ${asset?.frequency === "semiannual" ? "selected" : ""}>每半年</option><option value="annual" ${asset?.frequency === "annual" ? "selected" : ""}>每年</option><option value="irregular" ${asset?.frequency === "irregular" ? "selected" : ""}>不固定</option></select></div>
          <div class="form-row"><label>组合定位</label><select name="role"><option ${asset?.role === "高现金流" ? "selected" : ""}>高现金流</option><option ${asset?.role === "股息增长" ? "selected" : ""}>股息增长</option><option ${asset?.role === "资产增长" ? "selected" : ""}>资产增长</option><option ${asset?.role === "自定义" ? "selected" : ""}>自定义</option></select></div>
          <div class="form-row"><label>备用价格（USD）</label><input class="input" name="currentPrice" type="number" step="0.0001" min="0" value="${asset?.currentPrice || 0}" /></div>
        </div>
      </details>
      <button class="btn primary full" type="submit">保存标的</button>
      ${asset ? `<button class="btn danger full" type="button" data-action="delete-asset" data-id="${asset.id}">删除标的</button>` : ""}
    </form>
  </div></div>`;
}

function renderDisplaySettingsModal() {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-compact" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>显示</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="displaySettingsForm" class="form-grid"><div class="form-row"><label>显示货币</label><select name="displayCurrency"><option value="CNY" ${state.settings.displayCurrency === "CNY" ? "selected" : ""}>人民币 CNY</option><option value="USD" ${state.settings.displayCurrency === "USD" ? "selected" : ""}>美元 USD</option></select></div><div class="form-row"><label>备用汇率（USD/CNY）</label><input class="input" name="exchangeRate" type="number" step="0.0001" min="0.0001" value="${state.settings.exchangeRate}" /></div><button class="btn primary full" type="submit">保存</button></form>
  </div></div>`;
}

function renderGoalSettingsModal() {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal modal-compact" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>月收入目标</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="goalSettingsForm" class="form-grid"><div class="form-row"><label>目标金额（人民币/月）</label><input class="input" name="monthlyGoal" type="number" step="100" min="0" value="${state.settings.monthlyGoal}" required /></div><button class="btn primary full" type="submit">保存目标</button></form>
  </div></div>`;
}

function renderMilestoneSettingsModal() {
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>自由里程碑</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="milestoneSettingsForm" class="form-grid">${normalizeMilestones(state.settings.freedomMilestones).map((item, index) => `<div class="milestone-setting-row" data-milestone-index="${index}"><input class="input milestone-icon-input" data-milestone-field="icon" maxlength="8" value="${escapeHtml(item.icon)}" aria-label="里程碑图标" /><input class="input" data-milestone-field="name" maxlength="24" value="${escapeHtml(item.name)}" aria-label="里程碑名称" /><label><span>¥</span><input class="input" data-milestone-field="amountCny" type="number" min="1" step="1" value="${item.amountCny}" aria-label="里程碑金额" /></label></div>`).join("")}<p class="settings-hint">始终按人民币月均收入判断解锁。</p><button class="btn primary full" type="submit">保存里程碑</button></form>
  </div></div>`;
}

function renderPriceModal(assetId) {
  const asset = getAsset(assetId);
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>更新 ${escapeHtml(asset?.ticker || "")} 价格</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="priceForm" class="form-grid"><input type="hidden" name="assetId" value="${assetId}" /><div class="form-row"><label>当前价格（USD）</label><input class="input" type="number" name="currentPrice" step="0.0001" min="0" value="${asset?.currentPrice || ""}" autofocus required /></div><button class="btn primary full" type="submit">保存价格</button></form>
  </div></div>`;
}

function renderConfirmDividendModal(transactionId) {
  const tx = state.transactions.find((item) => item.id === transactionId);
  const asset = tx ? getAsset(tx.assetId) : null;
  if (!tx) return "";
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>确认 ${escapeHtml(asset?.ticker || "")} 股息到账</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <section class="confirm-summary">
      <div><span>除息日</span><strong>${escapeHtml(tx.exDate || "—")}</strong></div>
      <div><span>计划到账</span><strong>${escapeHtml(tx.paymentDate || tx.date)}</strong></div>
      <div><span>每股股息</span><strong>$${number(tx.perShare).toFixed(6)}</strong></div>
      <div><span>对应股数</span><strong>${number(tx.shareCount).toFixed(4).replace(/\.0+$/, "")}</strong></div>
      <div><span>预计税前</span><strong>${money(number(tx.grossDividend), "USD")}</strong></div>
      <div><span>预计净到账</span><strong>${money(number(tx.netDividend), "USD")}</strong></div>
    </section>
    <form id="confirmDividendForm" class="form-grid">
      <input type="hidden" name="transactionId" value="${tx.id}" />
      <div class="form-row"><label>实际到账日期</label><input class="input" type="date" name="actualDate" value="${todayKey()}" required /></div>
      <div class="form-row"><label>实际税前股息（USD）</label><input class="input" type="number" name="grossDividend" step="0.01" min="0" value="${number(tx.grossDividend).toFixed(2)}" required /></div>
      <div class="form-row"><label>预扣税与费用（USD）</label><input class="input" type="number" name="taxAndFees" step="0.01" min="0" value="${number(tx.taxAndFees).toFixed(2)}" /></div>
      <div class="form-row"><label>实际净到账（USD）</label><input class="input" type="number" name="netDividend" step="0.01" min="0" value="${number(tx.netDividend).toFixed(2)}" required /></div>
      <div class="form-row"><label>备注</label><textarea name="note" placeholder="例如：IBKR 实际到账">${escapeHtml(tx.note || "")}</textarea></div>
      <button class="btn primary full" type="submit">确认已到账</button>
    </form>
  </div></div>`;
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    currentTab = button.dataset.tab;
    window.scrollTo(0, 0);
    render();
  }));

  document.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", (event) => {
    const action = element.dataset.action;
    if (action === "close-modal" && element.classList.contains("modal-backdrop") && event.target !== element) return;
    handleAction(action, element, event).catch((error) => showToast(error.message || "操作失败，请重试"));
  }));

  const txForm = document.querySelector("#transactionForm");
  if (txForm) txForm.addEventListener("submit", submitTransaction);
  const assetForm = document.querySelector("#assetForm");
  if (assetForm) assetForm.addEventListener("submit", submitAsset);
  const priceForm = document.querySelector("#priceForm");
  if (priceForm) priceForm.addEventListener("submit", submitPrice);
  const confirmDividendForm = document.querySelector("#confirmDividendForm");
  if (confirmDividendForm) confirmDividendForm.addEventListener("submit", submitConfirmDividend);
  const displaySettingsForm = document.querySelector("#displaySettingsForm");
  if (displaySettingsForm) displaySettingsForm.addEventListener("submit", submitDisplaySettings);
  const goalSettingsForm = document.querySelector("#goalSettingsForm");
  if (goalSettingsForm) goalSettingsForm.addEventListener("submit", submitGoalSettings);
  const milestoneSettingsForm = document.querySelector("#milestoneSettingsForm");
  if (milestoneSettingsForm) milestoneSettingsForm.addEventListener("submit", submitMilestoneSettings);

  const txAsset = document.querySelector("#txAsset");
  if (txAsset && transactionType === "dividend") txAsset.addEventListener("change", () => {
    modal.assetId = txAsset.value;
    render();
  });

  const importFile = document.querySelector("#importFile");
  if (importFile) importFile.addEventListener("change", importData);
}

async function handleAction(action, element) {
  if (action === "toggle-currency") {
    state.settings.displayCurrency = state.settings.displayCurrency === "CNY" ? "USD" : "CNY";
    saveState(); render();
  }
  if (action === "open-add") { transactionType = "buy"; modal = { type: "transaction" }; render(); }
  if (action === "close-modal") { modal = null; render(); }
  if (action === "pick-type") { transactionType = element.dataset.type; render(); }
  if (action === "open-asset") { modal = { type: "asset" }; render(); }
  if (action === "asset-detail") { modal = { type: "asset", assetId: element.dataset.id }; render(); }
  if (action === "quick-price") { modal = { type: "price", assetId: element.dataset.id }; render(); }
  if (action === "confirm-dividend") { modal = { type: "confirm-dividend", transactionId: element.dataset.id }; render(); }
  if (action === "prev-month") { calendarCursor.setMonth(calendarCursor.getMonth() - 1); render(); }
  if (action === "next-month") { calendarCursor.setMonth(calendarCursor.getMonth() + 1); render(); }
  if (action === "select-date") { selectedDate = element.dataset.date; render(); }
  if (action === "open-display-settings") { modal = { type: "display-settings" }; render(); }
  if (action === "open-goal-settings") { modal = { type: "goal-settings" }; render(); }
  if (action === "open-milestone-settings") { modal = { type: "milestone-settings" }; render(); }
  if (action === "save-settings") { saveSettings(); }
  if (action === "refresh-all") { captureSettingsForm(); await refreshAllData(); }
  if (action === "refresh-fx") { captureSettingsForm(); await refreshFxOnly(); }
  if (action === "refresh-asset") { await refreshSingleAsset(element.dataset.id); }
  if (action === "export-data") { exportData(); }
  if (action === "import-data") { document.querySelector("#importFile")?.click(); }
  if (action === "reset-data") { resetData(); }
  if (action === "delete-asset") { deleteAsset(element.dataset.id); }
}

function submitTransaction(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const tx = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    assetId: data.assetId,
    type: transactionType,
    date: data.date,
    note: data.note || "",
  };
  if (["buy", "sell"].includes(transactionType)) {
    Object.assign(tx, { shares: number(data.shares), price: number(data.price), fees: number(data.fees) });
    if (transactionType === "sell") {
      const position = calculatePortfolio().positions.find((item) => item.asset.id === data.assetId);
      if (!position || number(data.shares) > position.shares + 1e-8) return showToast("卖出股数超过当前持仓");
    }
  } else {
    let gross = number(data.grossDividend);
    const perShare = number(data.perShare);
    const shareCount = number(data.shareCount);
    if (!gross && perShare && shareCount) gross = perShare * shareCount;
    Object.assign(tx, {
      status: data.status,
      shareCount,
      perShare,
      grossDividend: gross,
      taxAndFees: number(data.taxAndFees),
      netDividend: number(data.netDividend),
    });
  }
  state.transactions.push(tx);
  saveState();
  modal = null;
  showToast("记录已保存");
  render();
}

function submitConfirmDividend(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const tx = state.transactions.find((item) => item.id === data.transactionId);
  if (!tx || tx.type !== "dividend") return showToast("找不到这笔股息记录");
  const grossDividend = number(data.grossDividend);
  const taxAndFees = number(data.taxAndFees);
  const netDividend = number(data.netDividend);
  if (netDividend > grossDividend + 0.01) return showToast("净到账不能高于税前股息");
  Object.assign(tx, {
    status: "received",
    date: data.actualDate,
    actualDate: data.actualDate,
    grossDividend,
    taxAndFees,
    netDividend,
    isEstimatedNet: false,
    confirmedAt: new Date().toISOString(),
    note: String(data.note || "").trim(),
  });
  saveState();
  modal = null;
  showToast("股息到账已确认");
  render();
}

function submitDisplaySettings(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  state.settings.displayCurrency = data.displayCurrency === "USD" ? "USD" : "CNY";
  state.settings.exchangeRate = Math.max(0.0001, number(data.exchangeRate, 7.2));
  saveState(); modal = null; showToast("显示设置已保存"); render();
}

function submitGoalSettings(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  state.settings.monthlyGoal = Math.max(0, number(data.monthlyGoal, 1000));
  saveState(); modal = null; showToast("月目标已保存"); render();
}

function submitMilestoneSettings(event) {
  event.preventDefault();
  const rows = [...event.currentTarget.querySelectorAll(".milestone-setting-row")];
  state.settings.freedomMilestones = normalizeMilestones(rows.map((row, index) => ({
    id: defaultMilestones[index]?.id,
    icon: row.querySelector('[data-milestone-field="icon"]')?.value,
    name: row.querySelector('[data-milestone-field="name"]')?.value,
    amountCny: row.querySelector('[data-milestone-field="amountCny"]')?.value,
  })));
  saveState(); modal = null; showToast("自由里程碑已保存"); render();
}

function submitAsset(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const ticker = String(data.ticker).trim().toUpperCase();
  const existing = state.assets.find((asset) => asset.ticker === ticker && asset.id !== data.assetId);
  if (existing) return showToast("这个代码已经存在");
  const payload = {
    ticker,
    apiSymbol: String(data.apiSymbol || ticker).trim().toUpperCase(),
    name: String(data.name).trim(),
    type: data.assetType,
    frequency: data.frequency,
    role: data.role,
    manualDividendYieldPercent: String(data.manualDividendYieldPercent ?? "").trim() === "" ? null : Math.max(0, number(data.manualDividendYieldPercent)),
    currentPrice: number(data.currentPrice),
  };
  if (data.assetId) Object.assign(getAsset(data.assetId), payload);
  else state.assets.push({ id: crypto.randomUUID(), ...payload });
  saveState(); modal = null; showToast("标的已保存"); render();
}

function submitPrice(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const asset = getAsset(data.assetId);
  if (asset) asset.currentPrice = number(data.currentPrice);
  saveState(); modal = null; showToast("价格已更新"); render();
}

function captureSettingsForm() {
  const displayCurrency = document.querySelector("#displayCurrency");
  const exchangeRate = document.querySelector("#exchangeRate");
  const monthlyGoal = document.querySelector("#monthlyGoal");
  if (displayCurrency) state.settings.displayCurrency = displayCurrency.value;
  if (exchangeRate) state.settings.exchangeRate = number(exchangeRate.value, 7.2);
  if (monthlyGoal) state.settings.monthlyGoal = number(monthlyGoal.value, 1000);
  const milestoneRows = [...document.querySelectorAll(".milestone-setting-row")];
  if (milestoneRows.length) {
    state.settings.freedomMilestones = normalizeMilestones(milestoneRows.map((row, index) => ({
      id: defaultMilestones[index]?.id,
      icon: row.querySelector('[data-milestone-field="icon"]')?.value,
      name: row.querySelector('[data-milestone-field="name"]')?.value,
      amountCny: row.querySelector('[data-milestone-field="amountCny"]')?.value,
    })));
  }
  saveState();
}

function saveSettings() {
  try { captureSettingsForm(); } catch (error) { showToast(error.message); return; }
  showToast("设置已保存");
  render();
}

async function updateFxData() {
  const result = await fetchUsdCnyRate();
  state.settings.exchangeRate = result.rate;
  state.settings.exchangeRateDate = result.date;
  state.settings.exchangeRateUpdatedAt = new Date().toISOString();
  state.settings.exchangeRateSource = result.source;
  return result;
}

function resourceDue(asset, resource) {
  const maxAge = resource === "price" ? MARKET_REFRESH_MS : DIVIDEND_REFRESH_MS;
  return isStale(asset[`${resource}UpdatedAt`], maxAge) && isStale(asset[`${resource}AttemptAt`], RETRY_MS);
}

async function updateAssetMarketData(asset, options = {}) {
  const apiKey = String(state.settings.alphaVantageApiKey || "").trim();
  configureMarketEndpoint(getMarketEndpoint());
  if (!apiKey && !getMarketEndpoint()) throw new Error("备用直连模式需要个人 API Key；也可切回默认 Actions 快照");
  const updatePrice = !options.automatic || resourceDue(asset, "price");
  const updateDividend = !options.automatic || resourceDue(asset, "dividend");
  if (!updatePrice && !updateDividend) return { skipped: true };
  const symbol = asset.apiSymbol || asset.ticker;
  let quoteOk = false;
  let dividendOk = false;
  let dividendSync = { created: 0, updated: 0 };
  let lastError = null;
  const cannotRetry = (error) => /额度|预算|429|API Key/.test(error.message);

  if (updatePrice) {
    asset.priceAttemptAt = new Date().toISOString();
    try {
      consumeApiRequest();
      const quote = await fetchAlphaQuote(symbol, apiKey);
      if (getAsset(asset.id) !== asset) return { skipped: true };
      Object.assign(asset, { currentPrice: quote.price, priceTradingDay: quote.tradingDay,
        priceUpdatedAt: quote.fetchedAt || new Date().toISOString(), priceSource: quote.source,
        changePercent: quote.changePercent, priceLastError: quote.refreshWarning || null });
      quoteOk = true;
    } catch (error) {
      lastError = error;
      asset.priceLastError = error.message;
    }
  }

  if (updateDividend && !(lastError && cannotRetry(lastError))) {
    asset.dividendAttemptAt = new Date().toISOString();
    const sources = [fetchAlphaDividends, fetchAlphaMonthlyAdjustedDividends, fetchAlphaOverviewDividend];
    for (let index = 0; index < sources.length; index += 1) {
      await wait(350);
      try {
        consumeApiRequest();
        const result = await sources[index](symbol, apiKey);
        if (getAsset(asset.id) !== asset) return { skipped: true };
        if (index < 2 && !result.dividends.length) throw new Error("接口没有返回有效股息记录");
        if (index === 0) {
          asset.remoteDividends = result.dividends;
          asset.snapshotAnnualDividendPerShare = 0;
          asset.snapshotDividendYield = 0;
          dividendSync = syncDeclaredDividendTransactions(asset);
        } else if (index === 1) {
          asset.remoteDividends = mergeDividendRows(asset.remoteDividends, result.dividends);
        } else {
          asset.snapshotAnnualDividendPerShare = result.annualDividendPerShare;
          asset.snapshotDividendYield = result.dividendYield;
        }
        asset.dividendUpdatedAt = result.fetchedAt || new Date().toISOString();
        asset.dividendSource = result.source;
        asset.dividendDataQuality = result.quality || ["exact", "monthly", "snapshot"][index];
        asset.dividendLastError = result.refreshWarning || (index ? "精确日期暂不可用，已使用估算数据" : null);
        dividendOk = true;
        break;
      } catch (error) {
        asset.dividendLastError = error.message;
        lastError ||= error;
        if (cannotRetry(error)) break;
      }
    }
  }
  if (!quoteOk && !dividendOk) throw lastError || new Error(`${symbol} 更新失败`);
  return { quoteOk, dividendOk, dividendSync, partialError: lastError };
}

async function refreshFxOnly(options = {}) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  renderAfterSync();
  try {
    await updateFxData();
    saveState();
    if (!options.automatic) showToast("汇率已动态更新");
  } catch (error) {
    if (!options.automatic) showToast(`汇率更新失败：${error.message}`);
  } finally {
    refreshInProgress = false;
    saveState();
    renderAfterSync();
  }
}

async function refreshSingleAsset(assetId) {
  if (refreshInProgress) return;
  const asset = getAsset(assetId);
  if (!asset) return;
  refreshInProgress = true;
  renderAfterSync();
  try {
    const result = await updateAssetMarketData(asset);
    state.settings.lastMarketRefreshAt = new Date().toISOString();
    const createdText = result.dividendSync?.created ? `，新增 ${result.dividendSync.created} 笔待确认股息` : "";
    state.settings.lastMarketRefreshMessage = `${asset.ticker} ${result.quoteOk && result.dividendOk ? "价格与股息已更新" : "部分数据已更新"}${createdText}`;
    saveState();
    showToast(state.settings.lastMarketRefreshMessage);
  } catch (error) {
    state.settings.lastMarketRefreshMessage = `${asset.ticker} 更新失败：${error.message}`;
    saveState();
    showToast(state.settings.lastMarketRefreshMessage);
  } finally {
    refreshInProgress = false;
    renderAfterSync();
  }
}

async function refreshAllData(options = {}) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  renderAfterSync();
  const errors = [];
  let marketSuccess = 0;
  let createdDividendCount = 0;
  try {
    try {
      if (!options.automatic || isStale(state.settings.exchangeRateUpdatedAt, FX_REFRESH_MS)) await updateFxData();
    } catch (error) {
      errors.push(`汇率：${error.message}`);
    }

    const apiKey = String(state.settings.alphaVantageApiKey || "").trim();
    if (!apiKey && !getMarketEndpoint()) {
      errors.push("行情：尚未填写 Alpha Vantage API Key");
    } else {
      for (const asset of [...state.assets]) {
        if (!getAsset(asset.id)) continue;
        try {
          const result = await updateAssetMarketData(asset, options);
          if (result.skipped) continue;
          if (result.quoteOk || result.dividendOk) marketSuccess += 1;
          createdDividendCount += number(result.dividendSync?.created);
          if (result.partialError) errors.push(`${asset.ticker}：${result.partialError.message}`);
        } catch (error) {
          errors.push(`${asset.ticker}：${error.message}`);
        }
        saveState();
        await wait(350);
      }
    }

    if (marketSuccess > 0) state.settings.lastMarketRefreshAt = new Date().toISOString();
    state.settings.lastMarketRefreshMessage = marketSuccess > 0
      ? `${marketSuccess}/${state.assets.length} 只标的已更新${createdDividendCount ? `，新增 ${createdDividendCount} 笔待确认股息` : ""}${errors.length ? "，部分失败" : ""}`
      : errors[0] || "未更新到行情数据";
    saveState();
    if (!options.automatic) showToast(errors.length ? state.settings.lastMarketRefreshMessage : "汇率、价格和股息已更新");
  } finally {
    refreshInProgress = false;
    saveState();
    renderAfterSync();
  }
}

async function maybeAutoRefresh() {
  if (storageReadError || !state.settings.autoRefresh || !navigator.onLine || document.visibilityState === "hidden" || refreshInProgress || modal || currentTab === "settings") return;
  if (Date.now() - lastAutoCheck < 60000) return;
  lastAutoCheck = Date.now();
  const fxStale = isStale(state.settings.exchangeRateUpdatedAt, FX_REFRESH_MS);
  const marketStale = state.assets.some((asset) => resourceDue(asset, "price") || resourceDue(asset, "dividend"));
  try {
    if (marketStale && (state.settings.alphaVantageApiKey || getMarketEndpoint())) await refreshAllData({ automatic: true });
    else if (fxStale) await refreshFxOnly({ automatic: true });
  } catch { showToast("自动更新未完成，原有数据仍保留"); }
}

function exportData() {
  if (!storageReadError) { state.settings.lastBackupAt = new Date().toISOString(); saveState(); }
  const blob = new Blob([storageReadError ? localStorage.getItem(STORAGE_KEY) : JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `躺平股息备份-${isoDate(new Date())}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("备份已导出");
}

async function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (imported.version !== 1 || !Array.isArray(imported.assets) || !Array.isArray(imported.transactions)) throw new Error("invalid");
    const currentBackup = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(currentBackup);
    const link = document.createElement("a");
    link.href = url;
    link.download = `导入前自动备份-${isoDate(new Date())}.json`;
    link.click();
    URL.revokeObjectURL(url);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(imported));
    state = loadState();
    saveState();
    showToast("导入成功");
    render();
  } catch {
    showToast("文件格式不正确，未覆盖现有数据");
  }
}

function resetData() {
  if (!confirm("确定清空全部交易和设置？此操作不可撤销。")) return;
  state = structuredClone(defaultState);
  saveState();
  showToast("已恢复初始状态");
  render();
}

function deleteAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return showToast("找不到这个标的");
  const related = state.transactions.filter((tx) => tx.assetId === assetId);
  const counts = related.reduce((result, tx) => {
    if (tx.type === "buy") result.buy += 1;
    if (tx.type === "sell") result.sell += 1;
    if (tx.type === "dividend") result.dividend += 1;
    return result;
  }, { buy: 0, sell: 0, dividend: 0 });
  const message = related.length
    ? `${asset.ticker} 关联买入 ${counts.buy} 笔、卖出 ${counts.sell} 笔、股息 ${counts.dividend} 笔。\n\n继续将删除标的及全部 ${related.length} 笔相关记录。此操作会先自动备份，确定继续吗？`
    : `确定删除 ${asset.ticker} 吗？此操作会先自动备份。`;
  if (!confirm(message)) return;
  try {
    localStorage.setItem(DELETE_BACKUP_KEY, JSON.stringify({
      createdAt: new Date().toISOString(),
      deletedAssetId: assetId,
      state,
    }));
  } catch {
    return showToast("自动备份失败，已取消删除");
  }
  state.assets = state.assets.filter((asset) => asset.id !== assetId);
  state.transactions = state.transactions.filter((tx) => tx.assetId !== assetId);
  saveState();
  modal = null;
  showToast(related.length ? `标的及 ${related.length} 笔相关记录已删除` : "标的已删除");
  render();
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 2300);
}

if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshingForUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const refreshKey = `tangping-dividend.reloaded-${APP_VERSION}`;
    if (!hadController || refreshingForUpdate || sessionStorage.getItem(refreshKey)) return;
    if (modal || currentTab === "settings") { showToast("新版已就绪，完成编辑后重新打开即可更新"); return; }
    refreshingForUpdate = true;
    sessionStorage.setItem(refreshKey, "1");
    window.location.reload();
  });
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(`./sw.js?v=7.3`);
      await registration.update();
    } catch {
      // 离线启动时继续使用已缓存版本。
    }
  });
}

if (stateNeedsMigration) saveState();
render();
if (storageReadError) showToast("原有数据无法读取，已保护原始内容；请在设置导出备份");
setTimeout(() => maybeAutoRefresh(), 350);
window.addEventListener("online", () => { lastAutoCheck = 0; maybeAutoRefresh(); });
window.addEventListener("focus", () => maybeAutoRefresh());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") maybeAutoRefresh();
});
setInterval(() => maybeAutoRefresh(), 60000);
