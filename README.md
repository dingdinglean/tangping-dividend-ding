# 躺平股息

一个专注少量美股持仓与被动股息收入记录的移动端 PWA。

## 默认标的

- QQQI
- SPYI
- QNDX
- SCHD

也可以手动添加 NVO 或任何自定义代码，不依赖股票搜索数据库。

## 特点

- 纯静态 H5，无服务器费用。
- 数据只保存在当前浏览器本地存储。
- 记录买入、卖出、已收到/已宣布/预测股息。
- 自动计算持仓、平均成本、浮动盈亏、累计净股息和未来 12 个月估算。
- 支持人民币/美元切换、手动汇率、被动收入目标。
- 支持 JSON 导出与导入。
- 可通过 GitHub Pages 部署并添加到 iPhone 主屏幕。

## 本地预览

无需安装依赖：

```bash
python3 -m http.server 8080
```

浏览器打开 `http://localhost:8080`。

## GitHub Pages

仓库已经包含 `.github/workflows/pages.yml`。在仓库设置中进入：

`Settings → Pages → Build and deployment → Source → GitHub Actions`

保存后，推送到 `main` 分支会自动部署。

## 数据安全

代码可以公开，但交易数据不会进入 GitHub。数据仅保存在当前设备浏览器中。换手机或清理浏览器数据之前，请在“设置”中导出 JSON 备份。
