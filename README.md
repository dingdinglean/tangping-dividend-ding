# 躺平股息

移动端美股股息记录 PWA。

- 默认标的：QQQI、SPYI、QNDX、SCHD
- GitHub Actions 每天生成公开行情快照，App 关闭后仍更新；手机默认不需要 Key 或服务器 URL
- 启动、回到前台、恢复联网时自动读取最近快照；失败保留旧值与原获取时间
- 股息到账由用户确认
- 标的编辑中可填写“手动股息率”；留空则使用动态数据
- 首页区分预计月均和实际到账；2026 年图表自动推算未来派息月份，不把预测写进真实账本
- 四个 tab 均为独立的 100dvh App 页面；持仓列表和日历事件区按需在页面内部滚动
- 可在设置中自定义六个自由里程碑，始终按人民币月均收入判断
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

工作流每天北京时间 **05:30** 刷新，并于 **06:45** 作一次延迟重试。脚本以 `America/New_York` 的最近已完成 NYSE/Nasdaq 交易日为准：识别周末、法定休市和 13:00 ET 提前收盘，绝不以北京时间简单减一天。GitHub 调度可能延迟；定时任务只在默认分支生效，因此需要先合并 PR。

### 快照内容与额度

- 默认 QQQI、SPYI、QNDX、SCHD。每个行情记录保存 `symbol / price / price_date / source / fetched_at`；只有 `price_date` 等于最近完成交易日才会被写为有效值。Alpha Vantage 返回旧日线时自动尝试 Nasdaq 的常规收盘价，再尝试 Yahoo 日线。
- USD/CNY 单独每日刷新，保存 `rate / fx_date / source / fetched_at`；主源 Frankfurter 失败时使用 Open Exchange Rates。所有行情源失败时保留旧记录并标记 `stale`，页面显示“数据截至 YYYY-MM-DD”，不会把它计入总市值。
- QQQI、SPYI 的股息率为 NEOS 官方 `Distribution Rate`（独立保存数据日期）；QNDX、SCHD 用实际 distributions 的 TTM 计算，覆盖期不足 12 个月明确显示“数据不足”。累计股息始终只来自用户确认的真实到账记录。
- 文件只包含白名单公开价格、每股派息、日期及刷新状态/计数；脚本不读取浏览器持仓、交易或到账记录，密钥仅从环境变量读取，不写入文件和日志。
- 首次快照为空，等待配置 Secret 后真实抓取，不提供假行情。免费套餐未提供某接口时会回退或保留旧值，不承诺实时行情。
- 同一密钥被其他程序使用、删除预算文件、强制取消流程或 push 失败可能影响共享额度；不要并行使用其他抓取器或清空快照。工作流串行运行，抓取失败后仍尝试提交已保存的预算和状态。

### GitHub Pages 更新与离线

默认读取 `./data/market.json`，网络优先/no-store；离线或服务错误时回退最近成功缓存，保留数据原始日期。页面打开、回到前台或恢复联网时会重新验证 `price_date`；快照陈旧时会在后台尝试 Nasdaq、Yahoo 备用行情。模块内最多复用 60 秒，避免一个刷新周期重复下载。

**GitHub 默认令牌提交不会自动触发传统 Pages 重建。** 为避免 Pages 持续返回旧文件，`*.github.io/<仓库>/` 会按当前站点的 owner 和仓库名读取同仓库 `main/data/market.json` 的公开 raw 副本，选择 `generatedAt` 更新的一份；两份都在 GitHub 托管，不增加服务器、Secret 或工作流权限。用户站点根路径和自定义域名只读同目录 `./data/market.json`。raw CDN 可能有短暂传播延迟。[GitHub 官方说明](https://docs.github.com/en/actions/concepts/security/github_token)

### 版本与缓存

`package.json` 的 `version` 是唯一版本来源。`pwa-release.js` 的 `APP_VERSION`、页面和模块上的 `?v=`、Service Worker 脚本地址，以及缓存名 `tangping-dividend-v<version>` 都必须与它一致。发布时先改 `package.json`，再运行 `npm run sync-version`。`npm test` 会在这些标记不一致时失败。

打开页面会注册模块化 Service Worker（`updateViaCache: "none"`）并调用 `registration.update()`。新版本 `skipWaiting` 后接管页面，并只删除名称以 `tangping-dividend-` 开头、且不是当前版本的 Cache Storage。行情快照缓存 `tangping-market-snapshots-v2` 会留下，供离线回退。持仓、交易、设置和删除前备份在 `localStorage`（`tangping-dividend.v1`、`tangping-dividend.backup-before-delete`），升级不会读取、改写或删除这些键。应用版本没有写进存储键，避免一次发布把旧账本留在浏览器里却不再打开。

已发布过的应用壳缓存名包括 `tangping-dividend-v1`（仓库初次提交）、`tangping-dividend-v7.1`、`tangping-dividend-v7.3` 和升级前的 `tangping-dividend-v8.2`。当前名是 `tangping-dividend-v7.3.0`，和 `v7.3` 不是同一个缓存。`npm test` 会模拟这些旧缓存加上旧账本，跑当前 worker 的 `activate`，并确认交易、设置和 `tangping-dividend.backup-before-delete` 还在。GitHub Actions 工作流 **Test** 在 pull request 上运行同一套 `npm test`。

### Safari 与 iOS（没有在 iPhone 上验证）

以下根据 WebKit 的公开说明整理，不是 iPhone、iPad 或 Safari 的实测。本环境没有 WebKit 二进制，`node tests/browser.mjs` 的 WebKit 步骤会跳过。没有做过主屏幕安装、放置七天后再打开，或从后台恢复后的更新。

- **在 Safari 里大约七天不打开本站**：自 Safari 13.1 / iOS 13.4 起，若用户使用 Safari 的七天内没有访问该站点，WebKit 会删除该源上脚本可写的存储，包括 `localStorage`、IndexedDB、Cache Storage 和服务工作线程注册。[WebKit 说明](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)。这是系统策略，不是本应用的 `activate`。交易和删除前备份会一起被系统清掉。添加到主屏幕的 Web App 按 WebKit 的说法使用另一份数据，不应套用这七天上限；2020–2021 年仍有用户报告 iOS 清掉了主屏幕站点的数据。这两种情况都没有在手机上验证。长时间不用之前，请用设置里的「导出备份」。
- **主屏幕应用里的更新**：iOS 经常要等用户把应用从多任务界面划掉并重新点开，才会换上已经 `skipWaiting` 的新 worker。页面里的 `registration.update()` 和 `controllerchange` 自动刷新，在进程被挂起时可能不会发生。挂起或离线期间继续使用上一份壳。
- **模块 worker**：当前 worker 使用 `type: "module"`。更旧的 iOS 如果注册失败，会留在上一个经典脚本 worker；在线时，那个旧 worker 对不在其预缓存列表里的新 `?v=` 地址仍走网络。`updateViaCache: "none"` 用来避免 HTTP 缓存卡住 worker 的依赖，没有在 iOS 上确认。
- **存储压力**：iOS 可能回收 Cache Storage，严重时会清掉整个源。这不按版本号进行，离线壳可能失效，`localStorage` 也可能被系统一起删除。应用自己的激活步骤只删除旧的 `tangping-dividend-*` 应用壳，并保留行情快照缓存。
- **最早的 v1 worker** 会删除当时每一个名字不同的缓存。已经在那个版本运行过的设备，当时就可能丢掉其他缓存。现在的激活逻辑不会再这样做。

App 固定使用 Actions 静态快照，不向普通用户展示 API Key、服务地址或行情模式。旧版本地数据中的个人 Key、服务 URL、持仓、交易和到账记录会被保留，以保证导入导出兼容；市场公告仍然只生成待确认股息，不冒充实际到账。

已验证：[测试记录](docs/TESTING-V7.md)。移动截图使用合成测试数据：[首页](docs/screenshots/home-mobile-v7.png)、[图表](docs/screenshots/chart-mobile-v7.png)、[组合](docs/screenshots/portfolio-mobile-v7.png)、[深色](docs/screenshots/home-dark-v7.png)。
