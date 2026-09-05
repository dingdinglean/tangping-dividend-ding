# 躺平股息 V7

移动端美股股息记录 PWA。

- 默认标的：QQQI、SPYI、QNDX、SCHD
- 启动、回到前台、恢复联网时自动检查；按标的分别更新行情/公告，失败退避，直连每天最多 25 次请求
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

## 自动更新有两种模式

1. 原有直连模式：在设置填写个人 Alpha Vantage Key，App 打开时自动更新。保留已有 Key 与全部 v1 数据。
2. 共享后台模式：部署 [轻量行情服务](server/README.md)，在设置填写接口地址。后台常驻后，App 关闭时也会按计划刷新公开行情缓存；密钥只存服务器。

仓库已交付后台代码，但 GitHub Pages 不运行 Node，后台没有自动上线。需要服务器与行情密钥。市场公告不会被当作真实到账；派息月份未知时不伪造柱子。按当前持仓推算的预测不是投资收益保证。

已验证：[测试记录](docs/TESTING-V7.md)。移动截图使用合成测试数据：[首页](docs/screenshots/home-mobile-v7.png)、[图表](docs/screenshots/chart-mobile-v7.png)、[组合](docs/screenshots/portfolio-mobile-v7.png)、[深色](docs/screenshots/home-dark-v7.png)。
