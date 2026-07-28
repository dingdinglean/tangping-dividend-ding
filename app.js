const STORAGE_KEY = "tangping-dividend.v1";

const defaultState = {
  version: 1,
  settings: {
    displayCurrency: "CNY",
    exchangeRate: 7.2,
    monthlyGoal: 1000,
    lastBackupAt: null,
  },
  assets: [
    { id: crypto.randomUUID(), ticker: "QQQI", name: "NEOS Nasdaq-100 High Income ETF", type: "ETF", frequency: "monthly", currentPrice: 0, role: "高现金流" },
    { id: crypto.randomUUID(), ticker: "SPYI", name: "NEOS S&P 500 High Income ETF", type: "ETF", frequency: "monthly", currentPrice: 0, role: "高现金流" },
    { id: crypto.randomUUID(), ticker: "QNDX", name: "QNDX ETF", type: "ETF", frequency: "quarterly", currentPrice: 0, role: "资产增长" },
    { id: crypto.randomUUID(), ticker: "SCHD", name: "Schwab U.S. Dividend Equity ETF", type: "ETF", frequency: "quarterly", currentPrice: 0, role: "股息增长" },
  ],
  transactions: [],
};

let state = loadState();
let currentTab = "home";
let modal = null;
let transactionType = "buy";
let calendarCursor = new Date();
let selectedDate = isoDate(new Date());
let toastTimer = null;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || saved.version !== 1) return structuredClone(defaultState);
    return { ...structuredClone(defaultState), ...saved, settings: { ...defaultState.settings, ...saved.settings } };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
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
    const annualForecast = estimateAnnualDividend(item);
    return {
      ...item,
      marketValue,
      pnl,
      annualForecast,
      currentYield: marketValue > 0 ? annualForecast / marketValue : 0,
      yieldOnCost: item.cost > 0 ? annualForecast / item.cost : 0,
    };
  });

  const totals = positions.reduce((acc, item) => {
    acc.marketValue += item.marketValue;
    acc.cost += item.cost;
    acc.pnl += item.pnl;
    acc.received += item.receivedDividends;
    acc.annualForecast += item.annualForecast;
    return acc;
  }, { marketValue: 0, cost: 0, pnl: 0, received: 0, annualForecast: 0 });

  return { positions, totals };
}

function estimateAnnualDividend(item) {
  const records = [...item.dividendRecords].sort((a, b) => b.date.localeCompare(a.date));
  if (!records.length || item.shares <= 0) return 0;
  const frequency = item.asset.frequency;
  const count = frequency === "monthly" ? 3 : frequency === "quarterly" ? 4 : 2;
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
    if (tx.type !== "dividend" || !tx.date.startsWith(String(year))) return;
    const month = Number(tx.date.slice(5, 7)) - 1;
    if (month < 0 || month > 11) return;
    if (tx.status === "received") received[month] += number(tx.netDividend);
    if (tx.status === "announced") announced[month] += number(tx.netDividend);
    if (tx.status === "forecast") forecast[month] += number(tx.netDividend);
  });
  return { received, announced, forecast };
}

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = `
    <main class="app-shell">
      ${renderTopbar()}
      ${currentTab === "home" ? renderHome() : ""}
      ${currentTab === "portfolio" ? renderPortfolio() : ""}
      ${currentTab === "calendar" ? renderCalendar() : ""}
      ${currentTab === "settings" ? renderSettings() : ""}
    </main>
    ${renderBottomNav()}
    ${modal ? renderModal() : ""}
  `;
  bindEvents();
}

function renderTopbar() {
  const titles = {
    home: ["躺平股息", "今天离海边咖啡又近一点"],
    portfolio: ["投资组合", "只记真正长期持有的几只"],
    calendar: ["股息日历", "到账日比上班日更值得记"],
    settings: ["设置", "数据只保存在当前设备"],
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

function renderHome() {
  const { totals } = calculatePortfolio();
  const year = new Date().getFullYear();
  const chart = monthlyIncomeData(year);
  const yearReceived = chart.received.reduce((a, b) => a + b, 0);
  const currentMonth = new Date().getMonth();
  const monthExpected = chart.received[currentMonth] + chart.announced[currentMonth] + chart.forecast[currentMonth] || totals.annualForecast / 12;
  const monthlyGoalUsd = state.settings.monthlyGoal / number(state.settings.exchangeRate, 7.2);
  const progress = monthlyGoalUsd > 0 ? Math.min(100, monthExpected / monthlyGoalUsd * 100) : 0;
  const requiredCapital = totals.annualForecast > 0 && totals.marketValue > 0
    ? Math.max(0, (monthlyGoalUsd * 12 - totals.annualForecast) / (totals.annualForecast / totals.marketValue))
    : 0;

  return `
    <section class="card hero">
      <div class="hero-row">
        <div>
          <div class="eyebrow">当前资产</div>
          <div class="hero-value">${money(totals.marketValue)}</div>
          <div class="hero-sub">持仓成本 ${money(totals.cost)} · 浮动盈亏 <span class="${totals.pnl >= 0 ? "positive" : "negative"}">${money(totals.pnl)}</span></div>
        </div>
        <span class="tag">躺平路线</span>
      </div>
    </section>

    <section class="card hero" style="margin-top:14px">
      <div class="hero-row">
        <div>
          <div class="eyebrow">本月预计被动收入</div>
          <div class="hero-value">${money(monthExpected)}</div>
          <div class="hero-sub">未来 12 个月估算 ${money(totals.annualForecast)}</div>
        </div>
        <div style="text-align:right"><div class="eyebrow">目标</div><strong>${new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", maximumFractionDigits: 0 }).format(state.settings.monthlyGoal)}</strong></div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>
      <div class="progress-note"><span>完成 ${progress.toFixed(1)}%</span><span>还差 ${money(Math.max(0, monthlyGoalUsd - monthExpected))}/月</span></div>
    </section>

    <div class="grid-2">
      <div class="metric-card pink">
        <div class="metric-label">今年已收净股息</div>
        <div class="metric-value">${money(yearReceived)}</div>
        <div class="metric-foot">真实到账，可以喝咖啡</div>
      </div>
      <div class="metric-card orange">
        <div class="metric-label">预计新增本金</div>
        <div class="metric-value">${requiredCapital > 0 ? money(requiredCapital) : "—"}</div>
        <div class="metric-foot">按当前组合净股息率估算</div>
      </div>
    </div>

    <div class="section-title"><h2>${year} 年股息收入</h2><small>总计 ${money(yearReceived)}</small></div>
    ${renderIncomeChart(chart, monthlyGoalUsd)}
  `;
}

function renderIncomeChart(chart, goalUsd) {
  const values = chart.received.map((v, i) => v + chart.announced[i] + chart.forecast[i]);
  const max = Math.max(goalUsd, ...values, 1) * 1.18;
  const goalBottom = Math.min(100, goalUsd / max * 100);
  const bars = values.map((_, i) => {
    const r = chart.received[i] / max * 100;
    const a = chart.announced[i] / max * 100;
    const f = chart.forecast[i] / max * 100;
    return `<div class="bar-group"><div class="bar-stack" style="height:calc(100% - 24px)"><div class="bar received" style="height:${r}%"></div><div class="bar announced" style="height:${a}%"></div><div class="bar forecast" style="height:${f}%"></div></div><div class="month-label">${i + 1}月</div></div>`;
  }).join("");
  return `
    <section class="card chart-card">
      <div class="chart-head"><div><div class="eyebrow">实际 / 已宣布 / 预测</div><div class="chart-total">被动收入曲线</div></div><span class="tag">净股息</span></div>
      <div class="chart"><div class="goal-line" style="bottom:${goalBottom}%"></div>${bars}</div>
      <div class="legend"><span class="l1">已收到</span><span class="l2">已宣布</span><span class="l3">预测</span></div>
    </section>
  `;
}

function renderPortfolio() {
  const { positions, totals } = calculatePortfolio();
  return `
    <div class="summary-strip">
      <div class="summary-item"><strong>${money(totals.marketValue)}</strong><span>总市值</span></div>
      <div class="summary-item"><strong>${money(totals.received)}</strong><span>累计股息</span></div>
      <div class="summary-item"><strong>${money(totals.annualForecast / 12)}</strong><span>预计月均</span></div>
    </div>
    <div class="section-title"><h2>我的标的</h2><button class="btn" data-action="open-asset">添加标的</button></div>
    ${positions.map(renderAssetCard).join("")}
  `;
}

function renderAssetCard(item) {
  const totalDividend = item.receivedDividends;
  return `
    <article class="card asset-card" data-asset-card="${item.asset.id}">
      <div class="asset-head">
        <div class="asset-title"><h3>${escapeHtml(item.asset.name)}</h3><div class="ticker-row"><strong>${escapeHtml(item.asset.ticker)}</strong><span class="tag">${escapeHtml(item.asset.role)}</span></div></div>
        <div class="asset-value"><strong>${money(item.marketValue)}</strong><span>${item.shares.toFixed(4).replace(/\.0+$/, "")} 股</span></div>
      </div>
      <div class="asset-grid">
        <div><label>当前价格</label><strong>${money(number(item.asset.currentPrice), "USD")}</strong></div>
        <div><label>持仓成本</label><strong>${money(item.cost)}</strong></div>
        <div><label>浮动盈亏</label><strong class="${item.pnl >= 0 ? "positive" : "negative"}">${money(item.pnl)}</strong></div>
        <div><label>已收净股息</label><strong>${money(totalDividend)}</strong></div>
        <div><label>预计年股息</label><strong>${money(item.annualForecast)}</strong></div>
        <div><label>成本股息率</label><strong>${(item.yieldOnCost * 100).toFixed(2)}%</strong></div>
      </div>
      <div class="btn-row" style="margin-top:18px"><button class="btn" data-action="quick-price" data-id="${item.asset.id}">更新价格</button><button class="btn" data-action="asset-detail" data-id="${item.asset.id}">编辑标的</button></div>
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
    <section class="calendar-head">
      <div><div class="year">${year}</div><div class="month">${month + 1}月</div></div>
      <div class="calendar-actions"><button class="icon-btn" data-action="prev-month">‹</button><button class="icon-btn" data-action="next-month">›</button></div>
    </section>
    <section class="calendar-grid">
      ${["周日","周一","周二","周三","周四","周五","周六"].map((w) => `<div class="weekday">${w}</div>`).join("")}
      ${days.map((date) => renderDay(date, month)).join("")}
    </section>
    <div class="section-title"><h2>${selectedDate}</h2><small>${events.length} 条记录</small></div>
    <section class="card">${events.length ? events.map(renderEvent).join("") : `<div class="empty"><div class="big">☕</div>这一天没有交易或股息记录</div>`}</section>
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
  const title = tx.type === "buy" ? "买入" : tx.type === "sell" ? "卖出" : tx.status === "received" ? "股息到账" : tx.status === "announced" ? "已宣布股息" : "预测股息";
  const amount = tx.type === "dividend" ? money(number(tx.netDividend), "USD") : `${number(tx.shares)} 股 × ${money(number(tx.price), "USD")}`;
  return `<div class="event-item"><div><h4>${escapeHtml(asset?.ticker || "未知标的")} · ${title}</h4><p>${escapeHtml(tx.note || "无备注")}</p></div><strong>${amount}</strong></div>`;
}

function renderSettings() {
  const backupText = state.settings.lastBackupAt ? new Date(state.settings.lastBackupAt).toLocaleString("zh-CN") : "尚未备份";
  return `
    <div class="section-title"><h2>显示与目标</h2></div>
    <section class="card settings-group">
      <div class="setting-row"><div><label>显示货币</label><small>原始交易始终保存为美元</small></div><select id="displayCurrency"><option value="CNY" ${state.settings.displayCurrency === "CNY" ? "selected" : ""}>人民币 CNY</option><option value="USD" ${state.settings.displayCurrency === "USD" ? "selected" : ""}>美元 USD</option></select></div>
      <div class="setting-row"><div><label>美元兑人民币</label><small>手动汇率</small></div><input class="input" id="exchangeRate" type="number" step="0.0001" value="${state.settings.exchangeRate}" /></div>
      <div class="setting-row"><div><label>每月被动收入目标</label><small>人民币金额</small></div><input class="input" id="monthlyGoal" type="number" step="100" value="${state.settings.monthlyGoal}" /></div>
    </section>
    <button class="btn primary full" style="margin-top:14px" data-action="save-settings">保存设置</button>

    <div class="section-title"><h2>数据备份</h2><small>${backupText}</small></div>
    <section class="card settings-group">
      <div class="setting-row"><div><label>导出 JSON</label><small>换手机前务必备份</small></div><button class="btn yellow" data-action="export-data">导出</button></div>
      <div class="setting-row"><div><label>导入 JSON</label><small>导入前会先备份当前数据</small></div><button class="btn" data-action="import-data">导入</button></div>
      <div class="setting-row"><div><label>清空全部数据</label><small>恢复为 4 只默认标的</small></div><button class="btn danger" data-action="reset-data">清空</button></div>
    </section>
    <input class="file-input" id="importFile" type="file" accept="application/json" />

    <div class="section-title"><h2>说明</h2></div>
    <section class="card"><p style="margin-top:0">这是一个纯前端私人账本。持仓、交易和股息记录只保存在当前浏览器的本地存储中，不会上传到 GitHub。</p><p style="margin-bottom:0;color:var(--muted)">第一版不接行情接口。价格、汇率和股息由你手动更新，稳定优先。</p></section>
  `;
}

function renderBottomNav() {
  const items = [
    ["home", "⌂", "首页"],
    ["portfolio", "◔", "持仓"],
    ["calendar", "▦", "日历"],
    ["settings", "⚙", "设置"],
  ];
  return `<nav class="bottom-nav">${items.map(([tab, icon, label]) => `<button class="nav-btn ${currentTab === tab ? "active" : ""}" data-tab="${tab}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span></button>`).join("")}<button class="add-btn" data-action="open-add">＋</button></nav>`;
}

function renderModal() {
  if (modal.type === "transaction") return renderTransactionModal();
  if (modal.type === "asset") return renderAssetModal(modal.assetId);
  if (modal.type === "price") return renderPriceModal(modal.assetId);
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
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>${asset ? "编辑标的" : "添加标的"}</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="assetForm" class="form-grid">
      <input type="hidden" name="assetId" value="${asset?.id || ""}" />
      <div class="form-row"><label>股票代码</label><input class="input" name="ticker" maxlength="12" value="${escapeHtml(asset?.ticker || "")}" placeholder="例如 NVO" required /></div>
      <div class="form-row"><label>名称</label><input class="input" name="name" value="${escapeHtml(asset?.name || "")}" placeholder="允许自定义" required /></div>
      <div class="form-row"><label>类型</label><select name="assetType"><option ${asset?.type === "ETF" ? "selected" : ""}>ETF</option><option ${asset?.type === "Stock" ? "selected" : ""}>Stock</option><option ${asset?.type === "ADR" ? "selected" : ""}>ADR</option><option ${asset?.type === "Other" ? "selected" : ""}>Other</option></select></div>
      <div class="form-row"><label>分红频率</label><select name="frequency"><option value="monthly" ${asset?.frequency === "monthly" ? "selected" : ""}>每月</option><option value="quarterly" ${asset?.frequency === "quarterly" ? "selected" : ""}>每季度</option><option value="semiannual" ${asset?.frequency === "semiannual" ? "selected" : ""}>每半年</option><option value="annual" ${asset?.frequency === "annual" ? "selected" : ""}>每年</option><option value="irregular" ${asset?.frequency === "irregular" ? "selected" : ""}>不固定</option></select></div>
      <div class="form-row"><label>组合定位</label><select name="role"><option ${asset?.role === "高现金流" ? "selected" : ""}>高现金流</option><option ${asset?.role === "股息增长" ? "selected" : ""}>股息增长</option><option ${asset?.role === "资产增长" ? "selected" : ""}>资产增长</option><option ${asset?.role === "自定义" ? "selected" : ""}>自定义</option></select></div>
      <div class="form-row"><label>当前价格（USD）</label><input class="input" name="currentPrice" type="number" step="0.0001" min="0" value="${asset?.currentPrice || 0}" /></div>
      <button class="btn primary full" type="submit">保存标的</button>
      ${asset ? `<button class="btn danger full" type="button" data-action="delete-asset" data-id="${asset.id}">删除标的</button>` : ""}
    </form>
  </div></div>`;
}

function renderPriceModal(assetId) {
  const asset = getAsset(assetId);
  return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" data-modal-panel><div class="modal-handle"></div><div class="modal-head"><h3>更新 ${escapeHtml(asset?.ticker || "")} 价格</h3><button class="icon-btn" data-action="close-modal">×</button></div>
    <form id="priceForm" class="form-grid"><input type="hidden" name="assetId" value="${assetId}" /><div class="form-row"><label>当前价格（USD）</label><input class="input" type="number" name="currentPrice" step="0.0001" min="0" value="${asset?.currentPrice || ""}" autofocus required /></div><button class="btn primary full" type="submit">保存价格</button></form>
  </div></div>`;
}

function bindEvents() {
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    currentTab = button.dataset.tab;
    render();
  }));

  document.querySelectorAll("[data-action]").forEach((element) => element.addEventListener("click", (event) => {
    const action = element.dataset.action;
    if (action === "close-modal" && element.classList.contains("modal-backdrop") && event.target !== element) return;
    handleAction(action, element, event);
  }));

  const txForm = document.querySelector("#transactionForm");
  if (txForm) txForm.addEventListener("submit", submitTransaction);
  const assetForm = document.querySelector("#assetForm");
  if (assetForm) assetForm.addEventListener("submit", submitAsset);
  const priceForm = document.querySelector("#priceForm");
  if (priceForm) priceForm.addEventListener("submit", submitPrice);

  const txAsset = document.querySelector("#txAsset");
  if (txAsset && transactionType === "dividend") txAsset.addEventListener("change", () => {
    modal.assetId = txAsset.value;
    render();
  });

  const importFile = document.querySelector("#importFile");
  if (importFile) importFile.addEventListener("change", importData);
}

function handleAction(action, element) {
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
  if (action === "prev-month") { calendarCursor.setMonth(calendarCursor.getMonth() - 1); render(); }
  if (action === "next-month") { calendarCursor.setMonth(calendarCursor.getMonth() + 1); render(); }
  if (action === "select-date") { selectedDate = element.dataset.date; render(); }
  if (action === "save-settings") { saveSettings(); }
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

function submitAsset(event) {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const ticker = String(data.ticker).trim().toUpperCase();
  const existing = state.assets.find((asset) => asset.ticker === ticker && asset.id !== data.assetId);
  if (existing) return showToast("这个代码已经存在");
  const payload = {
    ticker,
    name: String(data.name).trim(),
    type: data.assetType,
    frequency: data.frequency,
    role: data.role,
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

function saveSettings() {
  state.settings.displayCurrency = document.querySelector("#displayCurrency").value;
  state.settings.exchangeRate = number(document.querySelector("#exchangeRate").value, 7.2);
  state.settings.monthlyGoal = number(document.querySelector("#monthlyGoal").value, 1000);
  saveState(); showToast("设置已保存"); render();
}

function exportData() {
  state.settings.lastBackupAt = new Date().toISOString();
  saveState();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
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
    state = imported;
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
  const hasTransactions = state.transactions.some((tx) => tx.assetId === assetId);
  if (hasTransactions) return showToast("该标的已有记录，不能直接删除");
  if (!confirm("确定删除这个标的？")) return;
  state.assets = state.assets.filter((asset) => asset.id !== assetId);
  saveState(); modal = null; showToast("标的已删除"); render();
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
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

render();
