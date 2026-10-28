# 打工工资提醒

这是躺平股息仓库里的一个独立定时任务。它按配置的月到手工资和中国工作日，在上海时间的工作日早上、晚上各发一条 Bark 通知。数字全部是模拟收入，不是银行卡到账，也不写入股息 App 的现金流。

不新增页面，不改 `app.js`，不改行情工作流。

## 行为

时区 `Asia/Shanghai`。只有计薪工作日才发：

- 08:05 标题正好是「今日待赚 ¥…」，例如 `今日待赚 ¥622.22`。通知正文直接写本月累计（不含今天）、距离下班、十周年倒计时和一条安慰。
- 18:05 标题正好是「下班啦 +¥…」，例如 `下班啦 +¥622.22`。通知正文直接写本月累计（含今天）、本月剩余工作日、十周年倒计时和一条安慰。

周末默认休息。法定节假日休息。国务院安排里的调休上班日照常计薪。每个计薪日的金额是当月可分配工资除以计薪天数的精确分数，累计用这个分数乘已完成天数，不先把每天四舍五入再相加。展示时才保留两位小数。没有加班调整时，月末最后一天的累计展示等于配置的月到手。

早上的「本月累计」不含今天。晚上把今天记入累计。累计按日历计算，不依赖上一条是否发送成功。2026 年 10 月按仓库里的 holiday-cn 日历有 18 个法定工作日，日薪展示为月薪的十八分之一。

十周年是个人纪念，不参与工资和工作日判断。`workAnniversary` 默认从 2019-08-01 起算，十周年是 2029-08-01。倒计时按上海时区的自然日，周末和节假日都算。正文里有两行：`距离上班十周年：还有N天`，以及 `已工作：X年X个月X天`。2029-08-01 当天的早晚消息改成纪念：肯定这十年的付出，并写明今天不是辞职日、可以选择接下来的生活。当天如果不是计薪工作日，也仍然发送，只是不写模拟工资。十周年之后不再出现负数，改成「上班十周年已达成」。随机文案里只有少数几条会提到这个节点。

## 配置

编辑 `wage-remind/config.json`：

| 字段 | 含义 |
| --- | --- |
| `monthlyNetYuan` | 月到手，默认 11200。最多两位小数 |
| `workStart` / `workEnd` | 工时，默认 08:00—18:00，用来算「距离下班」 |
| `morningEnabled` / `eveningEnabled` | 单独关闭早上或晚上 |
| `paidLeaveKeepsSalary` | 带薪假是否仍发满月薪，默认 true |
| `workAnniversary` | 开始上班日和十周年日，默认 2019-08-01 / 2029-08-01。只影响文案，不改变计薪 |
| `holidayOverrides` | 手动改某一天的放假/调休 |
| `adjustments` | 请假、额外休息、手动调休上班、明确金额的加班 |

`adjustments` 示例（默认文件里是空的）：

```json
{ "date": "2026-11-03", "kind": "paid_leave" }
{ "date": "2026-11-04", "kind": "unpaid_leave" }
{ "date": "2026-11-07", "kind": "rest" }
{ "date": "2026-11-08", "kind": "work" }
{ "date": "2026-11-05", "kind": "overtime", "cents": 0 }
```

- `paid_leave`：这天不发上下班提醒。默认不扣月薪，金额摊到其余工作日。
- `unpaid_leave`：这天不发提醒，并按「调整前这一天的份额」从月薪里扣掉。
- `rest`：额外休息，不扣月薪。
- `work`：手动指定上班（含周末或节假日调休），参与当月平摊，不另加工资。
- `overtime`：只有写了 `cents`（单位是分）才增加模拟收入。省略或写 0 都不会自动编加班费。同一天只能有一条调整。

法定节假日在 `wage-remind/data/holidays/`。数据来自国务院办公厅放假通知，经由 [holiday-cn](https://github.com/NateScarlet/holiday-cn) 整理，文件里保留 gov.cn 链接。某一年还没有安排时，脚本会直接失败，不会把节假日当成工作日。更新方式：

```bash
node wage-remind/refresh-holidays.mjs 2027
```

跨年当天会查看下一年的 1 月 1 日。下一年的文件要在那之前放进仓库。单日差异用 `holidayOverrides`，不必改历史文件：

```json
{ "date": "2026-10-28", "name": "临时放假", "isOffDay": true }
```

`isOffDay: false` 表示那天改为上班。

## 文案

`wage-remind/data/copy.json` 早、晚各 50 条以上。同一时段连续 14 个工作日不重复。周一多一句安慰，周三提醒这周过半，周五且紧接着就是双休时提到周末，法定节假日前一个工作日提到假期，本月最后一个工作日说明这个月的模拟收入已经记完。

文案站在「上班是换现金流，不是人生的全部」这一边。不写奋斗、拼搏、奉献、燃烧自己或加班有功。

## Bark 推送

使用 [Bark](https://bark.day.app) 的 JSON 接口，把标题和正文直接送到手机通知，不用打开网页。

`POST https://api.day.app/push`，`Content-Type: application/json; charset=utf-8`。设备密钥只放在 JSON 的 `device_key`，来自环境变量 `BARK_DEVICE_KEY`。不把密钥拼进 URL。

正文里的其他字段是固定的：

| 字段 | 值 |
| --- | --- |
| `group` | `打工自由助手` |
| `level` | `active`。普通通知，不用 `critical` 或 `timeSensitive`，也不传 `call` |
| `sound` | `bell`。Bark 内置提示音，不是警报 |

标题只有当天金额，没有竖线，也没有安慰短句、星期或「测试」：

- 早上：`今日待赚 ¥622.22`
- 晚上：`下班啦 +¥622.22`

上面是默认月薪 11200、2026 年 10 月 18 个工作日的展示。金额仍是当月精确分数，只在展示时保留两位小数。

通知正文放锁屏上就能看完：本月累计、距离下班或本月剩余工作日、`距离上班十周年：还有N天`、`已工作：X年X个月X天`，以及文案库里的一条安慰。同一句只出现一次，不再把短句和整段各贴一遍。末尾仍标明这是模拟收入，不是银行卡到账。

手动测试如果当天计薪，标题仍用上面的金额格式，正文以「【测试】」开头。当天不计薪时，标题是「确认推送通道」，正文同样标明测试，并且不写模拟工资。

成功的官方标准是 HTTP 200，并且响应 JSON 的 `code === 200`（`{"code":200,"message":"success","timestamp":...}`）。网络错误、无法解析的响应，或 HTTP 429/5xx，按 1 秒、2 秒再试，最多共 3 次。密钥错误等 4xx 不重试，避免短时间错误请求过多。

日志只记时段、日期、`code` 和是否重试。设备密钥、工资金额和正文都不会打印。

## GitHub Actions

工作流：`.github/workflows/wage-remind.yml`，名字是 **Wage remind**。

- 定时：UTC `5 0 * * *`（上海 08:05）和 `5 10 * * *`（上海 18:05）。是否工作日、早上/晚上是否启用，由脚本判断。
- 手动：Actions → Wage remind → Run workflow。`slot` 选 `test`、`morning` 或 `evening`。`test` 不占用当天早晚的防重复记录。`force` 会忽略工作日、开关和防重复，只用于排查。
- 权限只有读仓库和写 Actions cache。不会 `git commit`，也不会碰 `data/market.json`。
- 防重复的状态在 `wage-remind/.state/`，已被 gitignore。cache 若被回收，同一时段有可能再发一次。

GitHub 文档说明 schedule 在负载高时会延迟，仓库长时间没有活动时定时任务还可能被关掉。延迟时脚本仍按「这次触发的是早间还是晚间」发送，不会因为跑晚了改成另一条。若以后要更准的钟点，可以在腾讯云轻量的 crontab 里执行同一条命令，环境变量与下面的 Secret 相同，不要把设备密钥写进仓库。本仓库这一版只接入 Actions，不改其他线上任务。

```bash
WAGE_EVENT=schedule WAGE_SCHEDULE='5 0 * * *' node wage-remind/cli.mjs
```

## Secrets

仓库 Settings → Secrets and variables → Actions：

| 名称 | 是否必须 | 作用 |
| --- | --- | --- |
| `BARK_DEVICE_KEY` | 真正发送时需要 | Bark App 里该设备的 Device Key。只放在 Secret 或本机环境变量里 |

打开 Bark，在设备页复制 Device Key。没有这个 Secret 时，工作日的正式发送会失败并写明「缺少 BARK_DEVICE_KEY」。周末和非工作日会正常跳过。测试消息同样需要它。本地可以不连网：

```bash
WAGE_DRY_RUN=1 WAGE_EVENT=workflow_dispatch WAGE_SLOT=morning \
  WAGE_NOW=2026-10-28T00:05:00.000Z node wage-remind/cli.mjs
```

## 失败时看什么

- 日志出现「缺少 BARK_DEVICE_KEY」：Secret 还没配，或配在了别的环境。
- 「BARK_DEVICE_KEY 无效」：密钥里夹了空格、斜线或问号。回到 Bark 重新复制，不要带上 URL。
- 「Bark 拒绝了这条推送」：密钥无效，或 Bark 返回了非 200 的 `code`。4xx 不会自动重试。
- 「Bark 请求失败」：网络或服务暂时不可用。同一条最多共请求 3 次。
- HTTP 200 且 `code === 200` 但手机没看到：在 Bark 里确认这个 Device Key 仍是当前设备，以及系统通知权限开着。
- 「缺少某年法定节假日数据」：跑 `refresh-holidays.mjs`，核对 gov.cn 链接后再提交日历文件。

手动发一条到手机：Actions → Wage remind → Run workflow，`slot` 选 `test`。

## 和股息 App 的边界

- 不导入 `app.js`、`market-data.js` 或 `data/market.json`。
- 不写浏览器账本，不把模拟工资加进持仓或到账。
- 行情工作流 `update-market-data.yml` 不引用本目录。
- 本工作流不提交 git。
