# 躺平股息 V7.1

移动端美股股息记录 PWA。

- 默认标的：QQQI、SPYI、QNDX、SCHD
- GitHub Actions 每天生成公开行情快照，App 关闭后仍更新；手机默认不需要 Key 或服务器 URL
- 启动、回到前台、恢复联网时自动读取最近快照；失败保留旧值与原获取时间
- 股息到账由用户确认
- 标的编辑中可填写“手动股息率”；留空则使用动态数据
- 首页区分预计月均和实际到账；2026 年图表自动推算未来派息月份，不把预测写进真实账本
- 可自定义六个自由里程碑，始终按人民币月均收入判断，默认紧凑展示，可展开全部等级
- 投资组合卡片支持备份后级联删除标的及相关记录
- 数据保存在当前浏览器，可导出 JSON 备份

GitHub Pages：`Settings → Pages → main → /(root)`

## 运行与测试

Node.js 22+：`node server/server.mjs`，访问 http://127.0.0.1:4173。前端仍可直接部署到 GitHub Pages，无需打包。

- 逻辑及后台：`node --test tests/*.test.mjs`
- 浏览器：安装测试依赖 `npm install --no-save playwright`，然后 `npx playwright install chromium webkit`、`node tests/browser.mjs`
- 已有 Edge 可设置 `BROWSER_CHANNEL=msedge`；设置 `REQUIRE_WEBKIT=1` 可使缺少 WebKit 时测试失败而不是跳过。
- 测试使用独立浏览器上下文与明确标记的虚构测试资产，不读取或修改个人浏览器数据。

## 自动行情：只需配置一个 Secret

默认架构：**GitHub Actions → Alpha Vantage → data/market.json → GitHub Pages → 手机 PWA**。`server/` 仅为高级备用，不参与默认部署。

PR #2 合并到 `main` 后，唯一人工配置步骤是：

GitHub → **Settings → Secrets and variables → Actions → New repository secret**

- Name：`ALPHA_VANTAGE_API_KEY`
- Secret：你的 Alpha Vantage API Key

不需要常驻 Node 服务、不需要 PAT、不需要手机填写密钥，不用改变当前 Pages 主分支发布方式。

### 手动运行第一次更新

1. 进入仓库 **Actions**。
2. 左侧选择 **Update market data**。
3. 点击 **Run workflow**，选择 `main`，再点击绿色 **Run workflow**。
4. 等待完成后检查 `data/market.json`；手机重新打开 App 或点击“更新”。缺 Secret 会明确失败，不覆盖旧快照。

工作流使用 Node 22，每天 **22:37 UTC / 北京时间次日 06:37** 运行（美股夏令时和冬令时正常收盘后）。GitHub 调度可能延迟；定时任务只在默认分支生效，因此需要先合并 PR。

### 快照内容与额度

- 默认 QQQI、SPYI、QNDX、SCHD。正常 8 次请求；必要时回退月度历史/年度概览，单轮最多 16 次，同一 UTC 日累计最多 25 次（包括失败请求）。预算在请求前写入快照，重复手动运行也受限制。
- 只提交 `data/market.json`，仅变化时 commit/push。某接口失败保留上次有效数据、原 `_fetchedAt`，记录 `_status` / `_error`，其他标的继续。错误描述为固定代码，不包含上游原文或请求 URL。
- 文件只包含白名单公开价格、每股派息、日期及刷新状态/计数；脚本不读取浏览器持仓、交易或到账记录，密钥仅从环境变量读取，不写入文件和日志。
- 首次快照为空，等待配置 Secret 后真实抓取，不提供假行情。免费套餐未提供某接口时会回退或保留旧值，不承诺实时行情。
- 同一密钥被其他程序使用、删除预算文件、强制取消流程或 push 失败可能影响共享额度；不要并行使用其他抓取器或清空快照。工作流串行运行，抓取失败后仍尝试提交已保存的预算和状态。

### GitHub Pages 更新与离线

默认读取 `./data/market.json`，网络优先/no-store；离线或服务错误时回退最近成功缓存，保留数据原始时间。模块内最多复用 60 秒，避免一个刷新周期重复下载。

**GitHub 默认令牌提交不会自动触发传统 Pages 重建。** 为避免 Pages 持续返回旧文件，正式站点同时读取同仓库 `main/data/market.json` 的公开 raw 副本，选择 `generatedAt` 更新的一份；两份都在 GitHub 托管，不增加服务器、Secret 或工作流权限。raw CDN 可能有短暂传播延迟。[GitHub 官方说明](https://docs.github.com/en/actions/concepts/security/github_token)

设置保留三种模式：默认 Actions 快照、高级个人 Key 直连、高级 [Node 共享服务](server/README.md)。旧个人 Key 与服务器 URL 保留但默认不发送；可在设置显式切换。市场公告仍然只生成待确认股息，不冒充实际到账。

已验证：[测试记录](docs/TESTING-V7.md)。移动截图使用合成测试数据：[首页](docs/screenshots/home-mobile-v7.png)、[图表](docs/screenshots/chart-mobile-v7.png)、[组合](docs/screenshots/portfolio-mobile-v7.png)、[深色](docs/screenshots/home-dark-v7.png)。
