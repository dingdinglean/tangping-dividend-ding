# 可选共享行情后台

这是高级可选方案。**默认方案已改为 GitHub Pages + GitHub Actions 静态快照，不需要部署本目录。** 只需按根目录 README 配置一个 Actions Secret。

Node.js 22+，零第三方运行依赖。`npm start` 可直接运行本地 PWA（http://127.0.0.1:4173）；没有服务端密钥时仍可使用手机原有 API Key，后台接口明确返回不可用。

## 部署

1. 将此仓库部署到支持常驻 Node 进程和持久化磁盘的服务器。GitHub Pages 仅支持前端，不能运行此服务。
2. 参考 `.env.example` 设置环境变量；API Key 只配置在服务器，不能写进仓库。可以使用 `node --env-file=server/.env server/server.mjs`。不要提交 `.env`。
3. 用 HTTPS 反向代理转发到 127.0.0.1:4173。若平台需要监听所有接口，设置 `HOST=0.0.0.0`。配置准确的 `ALLOWED_ORIGIN`（协议+域名，无路径），限制浏览器跨域访问。
4. 为 `MARKET_CACHE_FILE` 配置持久化磁盘。单实例运行，避免多实例分别消费预算。损坏缓存会停止启动而非重置预算。
5. 手机设置中选择“高级：共享 Node 服务”，填写 `https://你的域名/api/market` 并保存。原有个人 API Key 保留但不会发送给后台；要切回请显式选择 Actions 快照或个人 Key 直连模式。

## 更新与边界

- 启动及每小时检查预设 `MARKET_SYMBOLS`，行情 18 小时、公告 24 小时过期才重新请求；App 关闭后服务仍独立运行。
- 月度历史与年度概览缓存 7 天。请求排队、并发去重，错误保留旧缓存并退避 30 分钟；过期且无法更新时返回错误，客户端继续显示旧值，不冒充新数据。
- 默认每日 25 次上游预算（UTC 日切换），包含失败请求，写入持久化文件。与其他使用同一密钥的应用额度共享，本地计数不能保证上游仍有额度。
- 仅允许部署者配置的标的与四种行情接口，不是任意 URL 代理。增加标的需修改 `MARKET_SYMBOLS`。规模扩大前核实供应商套餐及数据再分发许可，不承诺免费实时行情。
- CORS 不是鉴权。建议仅供个人使用；公开共享前增加网关限流/认证。即使被请求，白名单、缓存与硬预算限制上游消耗。
- 只缓存公开行情，不接收持仓、交易、股数、税费或个人 API Key。市场公告只生成待确认股息，真实净到账仍由用户确认。
- 本次不附带服务器账户、付费服务或线上密钥；仅有 GitHub Pages 不等于后台已经上线。

接口：`GET /api/market?function=GLOBAL_QUOTE&symbol=QQQI`。仅静态白名单文件对外提供，`.env`、缓存、源码目录和 `.git` 均不公开。

依据：[Node 环境变量](https://nodejs.org/api/environment_variables.html)、[Alpha Vantage 限额](https://www.alphavantage.co/support/)。
