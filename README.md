# 躺平股息

移动端美股股息记录 PWA。

- 默认标的：QQQI、SPYI、QNDX、SCHD、XQQI、CHPY
- GitHub Actions 每天生成公开行情快照，App 关闭后仍更新；手机默认不需要 Key 或服务器 URL
- 启动、回到前台、恢复联网时自动读取最近快照；失败保留旧值与原获取时间
- 股息到账由用户确认
- 标的编辑中可填写“手动股息率”；留空则使用动态数据
- 首页区分预计月均和实际到账；2026 年图表自动推算未来派息月份，不把预测写进真实账本
- 四个 tab 均为独立的 100dvh App 页面；持仓列表和日历事件区按需在页面内部滚动
- 可在设置中自定义五个自由里程碑，始终按人民币月均收入判断
- 投资组合卡片支持备份后级联删除标的及相关记录
- 数据保存在当前浏览器，可导出 JSON 备份

GitHub Pages：`Settings → Pages → main → /(root)`

## 运行与测试

Node.js 22+：`node server/server.mjs`，访问 http://127.0.0.1:4173。前端仍可直接部署到 GitHub Pages，无需打包。

- 逻辑及后台：`node --test tests/*.test.mjs`
- 浏览器：安装测试依赖 `npm install --no-save playwright`，然后 `npx playwright install chromium webkit`、`node tests/browser.mjs`
- 已有 Edge 可设置 `BROWSER_CHANNEL=msedge`；设置 `REQUIRE_WEBKIT=1` 可使缺少 WebKit 时测试失败而不是跳过。
- 测试使用独立浏览器上下文与明确标记的虚构测试资产，不读取或修改个人浏览器数据。

## 自动行情：可选配置 Alpha Vantage Secret

默认架构：**GitHub Actions → Alpha Vantage / Nasdaq regular close / Yahoo → data/market.json → GitHub Pages → 手机 PWA**。`server/` 仅为高级备用，不参与默认部署。

配置 Alpha Vantage 后可作为首选源；未配置时工作流仍会使用公开备用源：

GitHub → **Settings → Secrets and variables → Actions → New repository secret**

- Name：`ALPHA_VANTAGE_API_KEY`
- Secret：你的 Alpha Vantage API Key

不需要常驻 Node 服务、不需要 PAT、不需要手机填写密钥，不用改变当前 Pages 主分支发布方式。

### 手动运行第一次更新

1. 进入仓库 **Actions**。
2. 左侧选择 **Update market data**。
3. 点击 **Run workflow**，选择 `main`，再点击绿色 **Run workflow**。
4. 等待完成后检查 `data/market.json`；手机重新打开 App 即会读取新快照。缺 Secret 时会跳过 Alpha Vantage，不会覆盖已有有效记录。

工作流保留两次官方定时启动：UTC **18:05**（北京 02:05）和独立备用的 UTC **22:40**（北京 06:40）。另有一次幂等补偿：UTC **00:17**、周二到周六（北京 08:17），只在北京 08:00 截止之后跑；快照已经是最近完成交易日时不提交。三次启动各自使用独立的 concurrency group，`cancel-in-progress` 为 false，避免正在等待收盘的任务把备用启动排进同一个队列。这不是再铺一排整点重试，也不能保证 GitHub 一定创建 schedule 事件。

脚本按 `America/New_York` 计算当天 16:00（提前收盘日为 13:00），夏令时和标准时间都会跟着交易所走，不会把收盘写死成某一个 UTC 小时。若任务在收盘前就开始，它会睡到收盘后 10 分钟再抓；提前收盘日如果启动时已经过了 13:00、但还没到收盘后 10 分钟，同样会等到那 10 分钟。Nasdaq 历史表还没换日时改用 Nasdaq 官方 “Closed at” 收盘，再用 Alpha Vantage，最后用 Yahoo 日线。抓不到新交易日就每 3 分钟再试，直到北京时间 08:00。到点仍旧不是新收盘，就把上一笔价格标成 `stale` 并让任务失败。周末和休市日不会把前一个交易日标成“当日已收盘”之前的新交易日；收盘前的等待目标是即将完成的那场，写入时仍用已经完成的那场。

GitHub 可以延迟或直接不创建 schedule 运行。没被创建的事件在 Actions API 里没有 run、没有日志。定时任务只在默认分支生效。Actions 摘要会写明本次 event、`github.event.schedule`、actor、triggering actor、run id，以及每只标的的价格日期、来源、获取时间和派息合并结果。

### 快照内容与额度

- 默认 QQQI、SPYI、QNDX、SCHD、XQQI、CHPY。每个行情记录保存 `symbol / price / price_date / source / fetched_at`；只有 `price_date` 等于最近完成交易日才会被写为有效值。Nasdaq 历史表落后时先用 Nasdaq 官方收盘，再用 Alpha Vantage，最后用 Yahoo 日线。CHPY 的价格在这三处都失败时，才使用 YieldMax 页面的 Closing Price，并且日期必须等于已完成交易日；NAV 不会写入市价。
- USD/CNY 单独每日刷新，保存 `rate / fx_date / source / fetched_at`；主源 Frankfurter 失败时使用 Open Exchange Rates。所有行情源失败时保留旧记录并标记 `stale`。页面在价格日期不是最近完成交易日时，仍用上一笔收盘价估算市值和预期现金流，并写明日期和“沿用上一交易日收盘价”；完全没有价格时不计入总市值。
- QQQI、SPYI、XQQI 使用 NEOS 官方 `Distribution Rate`；QNDX 在派息历史不足时使用 State Street 的 `30 Day SEC Yield`；SCHD 使用实际 distributions 的 TTM。CHPY 只读取 [YieldMax 美国官网](https://yieldmaxetfs.com/our-etfs/chpy/)（NYSE Arca，CUSIP 88636R693）。页面必须同时出现该名称、交易所和 CUSIP；爱尔兰 UCITS（ISIN IE000T8QD852，HANetf / 欧洲交易所）会被拒绝。CHPY 年预测用除息日落在最近 365 天内的已公布周派息之和；历史跨度不足 365 天时改为已有周派息均值乘以 52，并标明样本不足一年。发行方把最近一周年化后的 Distribution Rate 只作为对照保存，不当作预测。来源刷新失败时保留上次数值并标记过期。一只失败不会中断另外五只，也不会把整份快照标成最新。累计股息始终只来自用户确认的真实到账记录。
- 文件只包含白名单公开价格、每股派息、日期及刷新状态/计数；脚本不读取浏览器持仓、交易或到账记录，密钥仅从环境变量读取，不写入文件和日志。
- 首次快照为空，等待配置 Secret 后真实抓取，不提供假行情。免费套餐未提供某接口时会回退或保留旧值，不承诺实时行情。
- 同一密钥被其他程序使用、删除预算文件、强制取消流程或 push 失败可能影响共享额度；不要并行使用其他抓取器或清空快照。同一次 cron 不会并行两份，不同 cron 可以各自启动，提交时 rebase。六只 ETF 都还能对上已完成交易日、且派息历史仍在时，才记为最新并提交。源站失败时，只要每只都还留着上一笔真实收盘价和派息记录，就会把过期状态写进 `data/market.json` 再提交，然后工作流失败，避免旧文件继续显示为刚更新成功。价格或派息历史会因此丢失、响应损坏或 push 失败时，不覆盖已发布的上一份文件，并且该步失败。较短或空白的派息列表不会删掉已保存的除息记录。CHPY 抓取失败时，另外五只仍按各自结果更新；CHPY 保留上一笔收盘和派息，并单独标成过期。

### GitHub Pages 更新与离线

默认读取 `./data/market.json`，网络优先/no-store；离线或服务错误时回退最近成功缓存，保留数据原始日期。页面打开、回到前台或恢复联网时会重新验证 `price_date`。快照日期未对齐最近完成交易日时，大约每 60 秒重读 `market.json`；对齐后恢复约 18 小时的低频检查。浏览器不再请求 Nasdaq 或 Yahoo，这两处仍只由 GitHub Actions 在服务端抓取。模块内最多复用 60 秒，避免一个刷新周期重复下载。

**GitHub 默认令牌提交不会自动触发传统 Pages 重建。** 为避免 Pages 持续返回旧文件，`*.github.io/<仓库>/` 会按当前站点的 owner 和仓库名读取同仓库 `main/data/market.json` 的公开 raw 副本，选择 `generatedAt` 更新的一份；两份都在 GitHub 托管，不增加服务器、Secret 或工作流权限。用户站点根路径和自定义域名只读同目录 `./data/market.json`。raw CDN 可能有短暂传播延迟。[GitHub 官方说明](https://docs.github.com/en/actions/concepts/security/github_token)

### 版本与缓存

`package.json` 的 `version` 是唯一版本来源。`pwa-release.js` 的 `APP_VERSION`、页面和模块上的 `?v=`、Service Worker 脚本地址，以及缓存名 `tangping-dividend-v<version>` 都必须与它一致。发布时先改 `package.json`，再运行 `npm run sync-version`。`npm test` 会在这些标记不一致时失败。

打开页面会注册模块化 Service Worker（`updateViaCache: "none"`）并调用 `registration.update()`。新版本 `skipWaiting` 后接管页面，并只删除名称以 `tangping-dividend-` 开头、且不是当前版本的 Cache Storage。行情快照缓存 `tangping-market-snapshots-v2` 会留下，供离线回退。持仓、交易、设置和删除前备份在这台设备的 `localStorage`（`tangping-dividend.v1`、`tangping-dividend.backup-before-delete`）。升级前若需要补目录，会先把当时的原始字符串写入 `tangping-dividend.backup-before-upgrade`，已有副本不会被后一次打开覆盖。这不是 GitHub 上的云端备份，也恢复不了另一台手机里的数据。应用版本没有写进存储键，避免一次发布把旧账本留在浏览器里却不再打开。

已发布过的应用壳缓存名包括 `tangping-dividend-v1`（仓库初次提交）、`tangping-dividend-v7.1`、`tangping-dividend-v7.3`、`tangping-dividend-v7.7.4` 和升级前的 `tangping-dividend-v8.2`。当前名是 `tangping-dividend-v7.7.5`。`tangping-dividend-v7.3.0` 和 `v7.3` 不是同一个缓存。`npm test` 会模拟这些旧缓存加上旧账本，跑当前 worker 的 `activate`，并确认交易、设置、删除前备份和升级前副本键还在。GitHub Actions 工作流 **Test** 在 pull request 上运行同一套 `npm test`。

### Safari 与 iOS（没有在 iPhone 上验证）

以下根据 WebKit 的公开说明整理，不是 iPhone、iPad 或 Safari 的实测。本环境没有 WebKit 二进制，`node tests/browser.mjs` 的 WebKit 步骤会跳过。没有做过主屏幕安装、放置七天后再打开，或从后台恢复后的更新。

- **在 Safari 里大约七天不打开本站**：自 Safari 13.1 / iOS 13.4 起，若用户使用 Safari 的七天内没有访问该站点，WebKit 会删除该源上脚本可写的存储，包括 `localStorage`、IndexedDB、Cache Storage 和服务工作线程注册。[WebKit 说明](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)。这是系统策略，不是本应用的 `activate`。交易和删除前备份会一起被系统清掉。添加到主屏幕的 Web App 按 WebKit 的说法使用另一份数据，不应套用这七天上限；2020–2021 年仍有用户报告 iOS 清掉了主屏幕站点的数据。这两种情况都没有在手机上验证。长时间不用之前，请用设置里的「导出备份」。
- **主屏幕应用里的更新**：iOS 经常要等用户把应用从多任务界面划掉并重新点开，才会换上已经 `skipWaiting` 的新 worker。页面里的 `registration.update()` 和 `controllerchange` 自动刷新，在进程被挂起时可能不会发生。挂起或离线期间继续使用上一份壳。
- **模块 worker**：当前 worker 使用 `type: "module"`。更旧的 iOS 如果注册失败，会留在上一个经典脚本 worker；在线时，那个旧 worker 对不在其预缓存列表里的新 `?v=` 地址仍走网络。`updateViaCache: "none"` 用来避免 HTTP 缓存卡住 worker 的依赖，没有在 iOS 上确认。
- **存储压力**：iOS 可能回收 Cache Storage，严重时会清掉整个源。这不按版本号进行，离线壳可能失效，`localStorage` 也可能被系统一起删除。应用自己的激活步骤只删除旧的 `tangping-dividend-*` 应用壳，并保留行情快照缓存。
- **最早的 v1 worker** 会删除当时每一个名字不同的缓存。已经在那个版本运行过的设备，当时就可能丢掉其他缓存。现在的激活逻辑不会再这样做。

App 固定使用 Actions 静态快照，不向普通用户展示 API Key、服务地址或行情模式。旧版本地数据中的个人 Key、服务 URL、持仓、交易和到账记录会被保留，以保证导入导出兼容；市场公告仍然只生成待确认股息，不冒充实际到账。

已验证：[测试记录](docs/TESTING-V7.md)。移动截图使用合成测试数据：[首页](docs/screenshots/home-mobile-v7.png)、[图表](docs/screenshots/chart-mobile-v7.png)、[组合](docs/screenshots/portfolio-mobile-v7.png)、[深色](docs/screenshots/home-dark-v7.png)。

### XQQI（7.7.0）

升级只补充一次零持仓 XQQI；按代码识别已有自定义标的，保留原 ID、交易和设置。删除后不会在下次打开时重新添加。第五卡沿用持仓页自然滚动，前四卡尺寸不变。行情价只用 Nasdaq / Yahoo 收盘价，或 NEOS 页面的 Closing Market Price；Closing NAV 不会写入市价。涨跌额和涨跌幅、以及最近收盘序列随同一 Actions 快照更新。抓取失败时保留上一笔有效价格和派息，并显示原来的更新时间。五只标的仍保有上一笔真实收盘和派息时，过期状态会写入快照，然后工作流失败。会丢掉价格或派息历史时不提交 `data/market.json`。

XQQI 自 2026-02 成立以来的已公布分配（宣布日、除息日、登记日、支付日、每股金额）来自 [NEOS 官方页面](https://neosfunds.com/xqqi/)。2026-11-10 官方页面与 Nasdaq 现金分红表都列出 2026-11-04 除息、宣布日 2026-11-03、登记日 2026-11-04、支付日 2026-11-06、每股 0.7548 美元；当前快照保留这一行，来源是 NEOS official Distribution History。12 月日历行没有金额，不生成记录，也不把空白写成 0。页面上的 Distribution Rate 按原名称展示；19%–23% 的 Annualized Distribution Target 不是实际收益率。可编辑预扣税率，留空继续沿用历史到账比例；不追溯改写历史记录。税后现金流才进入月度统计、图表和提醒。

### CHPY（7.7.5）

CHPY 是 NYSE Arca 的 YieldMax Semiconductor Portfolio Option Income ETF，美元计价，CUSIP 88636R693，基金起始日 2025-04-02。它按周派息。同名的欧洲 UCITS（ISIN IE000T8QD852，伦敦、米兰、Xetra）不接入，金额和日期都不用。

升级只补充一次零持仓 CHPY。已有同代码或 API 代码的标的保留原 ID。用户删除后不会在下次打开时加回来。升级前的 `localStorage` 原文会留在这台设备的 `tangping-dividend.backup-before-upgrade`。设置里的「恢复升级前本机副本」会把这份原文载回；新版本仍会再补一次零持仓 CHPY，原有买卖、到账和设置保留。GitHub 仓库里没有用户的 iPhone 账本，不能从这里恢复手机数据。

2026-11-12 抓取时，Nasdaq 历史收盘给出 2026-11-11 的 55.07 美元。YieldMax 官网同一时刻的 Closing Price 仍是 2026-11-10 的 52.41 美元，因此快照用 Nasdaq，不用 NAV 52.33。官网派息表 83 行，最早 2025-04-17 除息、每股 0.3627 美元，最新 2026-11-12 除息、宣布 2026-11-10、登记 2026-11-12、支付 2026-11-13、每股 0.4127 美元。空白金额不会写成 0，也不会生成未来公告。月现金流按支付日入账；除息在 2026-09-30、支付在 2026-10-01 的那一笔算 10 月。年预测是近 365 天已公布周派息之和，当前样本跨过一年，页面标成 TTM 和每周。样本不足一年时才标估算，并且用周均值乘 52，不乘 12。预测只出现在首页图表，不写进账本，也不编造未来的公告日。

