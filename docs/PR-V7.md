## 本次改造

基于已合并的 #1，参考用户提供的 Firenote 截图完善自动更新和信息层级，不复制截图中的持仓或收入。

**本 PR 已继续升级为 V7.1：默认使用 GitHub Pages + GitHub Actions 静态行情，不再要求常驻 Node 后台。仍是 PR #2 / agent/automatic-income-v7。**

最终架构：**GitHub Actions → Alpha Vantage → data/market.json → GitHub Pages → 手机 PWA**。`server/` 仅保留为高级备用。

### 修改文件

- `app.js`：启动/前台/联网检查、逐标的逐资源新鲜度、重试退避、25 次预算、预测月份派生、稳定月均收入口径、紧凑里程碑与组合、数据损坏写保护。
- `.github/workflows/update-market-data.yml`：workflow_dispatch + 每天 22:37 UTC；Node 22；仅 contents: write；Secret 仅放抓取步骤环境；只有 data/market.json 变化才 commit/push。
- `scripts/update-market-data.mjs`、`data/market.json`：四只默认标的、正常 8 次/单轮最多 16 次/每日累计最多 25 次；接口失败保留有效值，记录安全失败码；只保存白名单公开数据。
- `market-data.js`：Actions 快照、直连、可选共享服务三种模式；复用四个现有 parser；保留真实获取时间，离线回退。
- `styles.css`：浅色/深色卡片和两列数据、紧凑层级、图表右侧刻度、手机删除按钮。
- `index.html`、`manifest.webmanifest`、`sw.js`：统一 v7.1；快照 no-store/网络优先，离线回退成功缓存；只清理本应用缓存，保留一次刷新保护。
- `server/server.mjs`、`server/.env.example`、`server/README.md`：零运行依赖 Node 后台，定时预热、持久缓存/预算、请求去重、标的白名单与 CORS、部署说明。
- `package.json`、`tests/*`、`README.md`、`.gitignore`、`docs/TESTING-V7.md`、`docs/screenshots/*-v7.png`：运行入口、回归测试、文档和合成测试截图。

### 修复问题

- 原自动更新一次性标志导致回到前台/恢复联网无法补同步；全局成功时间掩盖部分标的失败。
- 原月度图表只统计记录，年度预测不会生成未来柱子。现在按持仓/频率/历史锚点派生未来月份，有已宣布/到账/手动预测记录的月份不再叠加派生预测，未知季度月份留白。
- 原“本月被动收入”在实际记录与年预测/12之间切换，里程碑判断跳变；现在月均与实际到账分开。
- 原月目标参与纵轴最大值会压缩柱高。保留明确像素柱高、零月空白，采用数据自适应比例。
- 后台刷新不替换正在编辑的表单；未知价格不冒充零市值/确定亏损。

### 旧数据兼容

沿用 `tangping-dividend.v1`，合并补充默认设置，保留资产、交易、股息、API Key 和其他设置。派生预测只存在内存，绝不插入真实交易。收到的净股息金额不会被公告覆盖。删除前备份并级联清理；异步返回也不能给已删除标的创建孤儿记录。无法解析的旧数据停止写回并允许导出原文。

### 测试

- 28 项 Node 测试全部通过，包含原有 19 项及静态解析、失败保留、无 Secret、无个人数据/密钥、重复运行预算等新增场景。
- Chromium：390/430/1280px 布局、亮/暗截图、12 月柱图、新增、两类删除及取消、备份、持久化、设置保存、离线启动，无 JavaScript pageerror。
- 受控旧 PWA -> v7.1 缓存升级实测仅刷新一次。
- WebKit：390px 非零柱高可见、无横向溢出。
- Chromium / WebKit：无个人 Key 读取、更新快照、离线/503 保留最近有效快照均通过。Windows WebKit 离线顶层导航有运行时限制，测试其离线资源读取；Chromium 测试完整离线重载。
- JS 语法检查、`git diff --check` 通过。
- 新工作流通过 actionlint 1.7.12 检查；仅声明 contents: write，无额外令牌权限。
- 测试均在独立上下文使用虚构 DEMO 数据，没有读取/修改用户真实持仓。WebKit 不是物理 iPhone 安装实测。

### 部署边界

PR 合并后只剩一个人工配置：GitHub → Settings → Secrets and variables → Actions → New repository secret，Name = `ALPHA_VANTAGE_API_KEY`，Value = 个人 Alpha Vantage 密钥。手机默认不需 Key 或服务器 URL。

首次手动运行：Actions → Update market data → Run workflow → main → Run workflow。之后每天 22:37 UTC（北京时间次日 06:37）自动运行。快照当前为空，不伪造行情；未读取或配置真实 Secret，也未代运行线上抓取。

**处理了 Pages 陷阱：** GITHUB_TOKEN 提交不触发传统 Pages 重建。正式 Pages 页面默认读相对快照，并自动比较同仓库 main 的公开 raw 副本，选择较新 generatedAt，避免旧部署遮住新行情。无需额外 PAT、服务器或 pages:write 权限；raw CDN 可能有短暂延迟。[GitHub 文档](https://docs.github.com/en/actions/concepts/security/github_token)

Node 服务仅高级可选；真实到账仍需确认，免费接口可用性以供应商为准。原有 Key 和 URL 保留为高级备用，用户持仓/交易/实际股息不改动。

### 移动截图（合成测试数据）

![首页](https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/agent/automatic-income-v7/docs/screenshots/home-mobile-v7.png)

![年度图表](https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/agent/automatic-income-v7/docs/screenshots/chart-mobile-v7.png)

![投资组合](https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/agent/automatic-income-v7/docs/screenshots/portfolio-mobile-v7.png)

![深色模式](https://raw.githubusercontent.com/dingdinglean/tangping-dividend-ding/agent/automatic-income-v7/docs/screenshots/home-dark-v7.png)
