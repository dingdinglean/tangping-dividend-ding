# CHPY 7.7.5 审查记录

本轮停在 PR 和测试，没有 merge，也没有手动触发 Actions。

## 基线

- 工作起点：`origin/main` `a0bf1cc4e918b5acbc1fad1d8d42700f55e663d7`
- 实现提交：`ffc4121ee2201b2c2f24fa87bf6cd46504593e9d`。PR head 以 GitHub 上该分支最新提交为准。
- 快照备份：`/tmp/chpy-baseline/market-a0bf1cc.json`
- SHA256：`f9fe241d83595eda251b8ce4727ebddd648b819e9a2899783789230817dc9767`
- 回退该公开快照时，用这个提交里的 `data/market.json`。它不含用户持仓。

QQQI、SPYI、QNDX、SCHD、XQQI 的价格、派息行数与基线逐字节相同：33、50、1、60、10 行。CHPY 是新增对象。

## 身份

接入的是美国基金，不是欧洲同名产品。

| 项目 | 美国 CHPY | 欧洲同名 |
| --- | --- | --- |
| 名称 | YieldMax Semiconductor Portfolio Option Income ETF | YieldMax Semiconductor Option Income UCITS ETF |
| 市场 | NYSE Arca | LSE / Borsa Italiana / Xetra |
| 标识 | CUSIP 88636R693 | ISIN IE000T8QD852 |
| 起始 | 2025-04-02 | 2026-02-24 / 2026-02-25 |
| 货币 | USD | 份额有 USD、EUR、GBP 等报价 |
| 派息 | 周派息 | 不使用 |

页面必须同时包含 “Semiconductor Portfolio Option Income ETF”、`NYSE Arca` 和 `88636R693`。出现 `UCITS` 或 `IE000T8QD852` 时整页拒绝。

官方页面：<https://yieldmaxetfs.com/our-etfs/chpy/>

抓取时间：`2026-11-12T03:37:37.816Z`

## 这次写入的公开行情

- 收盘：Nasdaq historical close，2026-11-11，**55.07 USD**，相对 2026-11-10 的 52.41，变动 +2.66（+5.0754%）
- 官网 Closing Price 仍停在 2026-11-10 的 52.41，没有拿来覆盖 11 月 11 日收盘
- 官网 NAV 52.33 没有写入市价
- 价格历史：120 个交易日，来源 Nasdaq
- 派息：83 行，来源 `YieldMax official Distribution History`
- 最早：宣布 2025-04-16，除息 2025-04-17，登记 2025-04-17，支付 2025-04-21，每股 0.3627
- 最新：宣布 2026-11-10，除息 2026-11-12，登记 2026-11-12，支付 2026-11-13，每股 0.4127
- 83 行都有宣布、除息、登记、支付和每股金额。没有把空单元格写成 0
- 第一行 ROC 在官网是破折号，快照不保存 ROC，也不把它写成 0
- 年预测：除息日不晚于 2026-11-11 的近 365 天周派息之和 27.6161 USD，除以 55.07，约 50.15%。这 52 笔的除息日是 2025-11-12 至 2026-11-04，`sample_span_days` 是 357。它不是全部历史的跨度。`coverage: complete`，方法 `trailing_365_day_sum`
- 官网 Distribution Rate 40.96%（as of 2026-11-10）只按“最近一次派息年化”对照保存，不进入预测

## 已知缺口

- 2026-11-12 的除息已公布，但晚于已完成的价格交易日 2026-11-11，所以它在派息表里，不在这次 TTM 的 365 天合计里。TTM 的数据日是 2026-11-04。
- 基金从 2025-04-02 起已超过一年，当前快照标的是完整 TTM，不是“样本不足一年”。样本不足的路径用已有周均值乘 52，并在页面标明估算；单测覆盖了这条路径。
- 预测只进首页图表。它按历史支付日最常见的星期几估计每个月有 4 次还是 5 次，不写进账本，也不生成未来公告日或金额。
- 欧洲基金 2026-10-19 的 0.4572 美元没有进入快照。
- 没有在 iPhone、iPad 或主屏幕 PWA 上测试。Chromium / WebKit 和 375、390、440、768、1440、横屏都是视口模拟。
- 用户持仓、交易和到账在浏览器 `localStorage` 的 `tangping-dividend.v1`。删除前副本是 `tangping-dividend.backup-before-delete`。这次升级会在本机再写 `tangping-dividend.backup-before-upgrade`。GitHub 上没有这些个人数据，不能从仓库恢复某台 iPhone 的账本。
- 恢复升级前副本会载回当时的原文；新版本仍会再补一次零持仓 CHPY，原有买卖和到账保留。
- 本轮没有 dispatch Actions。定时任务仍是 UTC `5 18 * * 1-5`、`40 22 * * 1-5`，补偿是 `17 0 * * 2-6`。

## Actions

CHPY 失败时，另外五只继续按各自结果更新。CHPY 保留上一笔收盘和派息，`price_status` 为 `stale`，并带 `price_error`。整份快照的 `freshness` 保持 `stale`，不会因为另外五只成功就标成最新。空白或更短的派息表不能删掉已有除息行。旧快照没有逐标的状态字段时，刷新会补上，不会把缺字段当成 0。

## 测试

工作目录：`/agent/repos/tangping-dividend-ding`

| 命令 | exit | 结果 |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | 0 | 126 pass / 0 fail |
| `REQUIRE_WEBKIT=1 node tests/browser.mjs` | 0 | Chromium 与 WebKit：四 tab、375/390/440/768/1440、横屏 844×390、CHPY 持仓/跨月到账确认/人民币换算、离线与 503 回退、旧缓存升级后 localStorage 仍在 |
| `REQUIRE_WEBKIT=1 node tests/mobile-layout.mjs` | 0 | Chromium 与 WebKit 各 11 个视口，`horizontalOverflow` 全部为 false |

Playwright 1.65.0。浏览器测试使用一次性上下文和合成持仓，不读取个人浏览器数据。

单测覆盖：升级前本机副本只写一次、恢复后原账本还在、删除后的 CHPY 不会自动加回、支付日跨月归属、9 月 4 笔与 10 月 5 笔、除息日前的买卖股数、重复确认不新增第二笔、周预测不写成月预测、样本不足一年、CHPY 源失败时另外五只仍为当日收盘。

## 发布与回滚

审查通过后才 merge 到 `main`。Pages 从 `main` 读取。合并后若要立刻刷新，再手动运行 Update market data；本轮不要提前 dispatch。

回滚应用：revert 这个合并提交。已打开的新版本如果已经写了本机升级副本，可在设置里恢复，或导入升级前导出的 JSON。公开快照可回到 `a0bf1cc` 的 `data/market.json`。不要用一份旧的五标的快照覆盖已经包含 CHPY 历史的文件，除非确认要整份回退。
