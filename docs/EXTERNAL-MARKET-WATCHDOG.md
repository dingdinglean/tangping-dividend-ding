# Independent 08:30 freshness guard

## Status, 2026-11-24 (Asia/Shanghai)

Code and isolated tests are in this repository. The systemd units below are deployment templates, **not evidence of installation**. No Tencent Cloud configuration, SSH identity, other production site, or notification channel was changed. The available restricted `remindctl` entry is not authorization to install this service. Installation requires an independently approved administrator entry, a dedicated scoped Actions credential, and timer/journal acceptance evidence. Until then use an authorized external Grok Bot routine with this same decision policy; do not claim a Tencent timer is running.

Recovery: https://github.com/dingdinglean/tangping-dividend-ding/actions/runs/45305250760 succeeded. Real snapshot commit `1523bec4c3dcab41ac87b0db795ef4f280e8d38e` has all six closes dated 2026-11-23, generated 2026-11-24 09:28:13 Asia/Shanghai. Its Pages deployment succeeded: https://github.com/dingdinglean/tangping-dividend-ding/actions/runs/45305327523 .

## Proven vs unknown cause

The default-branch workflow is active, the repository is neither disabled nor archived, the three UTC cron expressions are valid and unchanged, and the API reports zero schedule runs in the incident window (2026-11-23 00:00 through 2026-11-24 09:25 Asia/Shanghai). There was no update run to fail, wait for concurrency, or call a quote provider. Manual dispatch promptly ran and obtained six current closes, with existing fallbacks. This places the observed failure **before run creation**, not in the quote updater, Pages, retry loop, or push step.

GitHub documents schedule delay/drop under load, and also an unavailable schedule actor as another possible reason. Last successful scheduled run actor was `dingdinglean`; this does not establish the account's private eligibility at the missing ticks. Internal scheduler delivery/drop reasons and account suspension state are not exposed by this run history. Load/drop is a plausible explanation, **not a proven internal root cause**. Do not manufacture a backend diagnosis or add more cron entries.

References: https://docs.github.com/en/actions/how-tos/troubleshoot-workflows and https://docs.github.com/en/actions/reference/events-that-trigger-workflows#schedule .

## Policy and usage

`node scripts/market-watchdog.mjs` performs a real read-only/dry-run check. It uses the official GitHub API, fixed to this repository and workflow 350907457, and writes only its local lock/state directory. It never edits market data, formulas, holdings, dividends, or the other applications. `--dispatch --monitor` enables the already-authorized workflow dispatch and observes it for at most 20 minutes. Default state path is `./watchdog-state/state.json`; production must set a persistent private `DIVIDEND_WATCHDOG_STATE`.

- Reuse `market-calendar.js`: latest **completed** New York session, weekends, holidays, half-days, DST; never assume yesterday.
- All six valid prices and their actual session dates must match. `generatedAt` alone is never freshness. Malformed data / missing dividend history fails closed.
- Read current main snapshot and recent runs; query every active status separately so old queued/sleeping runs count. Any active main run suppresses dispatch. A run stuck for six hours alerts.
- A current successful run but stale repository data alerts rather than creating a storm. Pages lag alone does not trigger another data update.
- An exclusive filesystem lock and atomic private state record the session intent **before** POST. HTTP/network ambiguous POST is never retried automatically. GET retries are bounded (3, 20-second request timeout); do not print response bodies or credentials.
- Recheck main/run state immediately before dispatch. Persist accepted intent; allow at most two requests for a session, and the second only after an observed confirmed failed first run and 60-second cooldown. A missing run or lost response requires operator review; do not delete state just to force a retry.
- The existing workflow, manual dispatch and watcher/crons are unchanged. The updater, retry waterfall, market calendar and protected dividend merge are unchanged. A proposed extra checkout gate was NOT deployed: GitHub rejected a push containing workflow edits because the existing OAuth session lacks `workflow` scope. No other token, connector or browser was used to bypass that refusal. This delivered change is deliberately limited to non-workflow files within existing permissions.
- This is not a distributed exactly-once guarantee: a GitHub cron can start in the last network race. Existing manual concurrency and unchanged-snapshot no-op limit redundant work, but a same-instant cron and external dispatch can still both fetch quotes. A workflow-level checkout gate remains pending explicit authorization through the normal provider connection. Run only **one external authority** (Tencent timer OR Grok Bot routine), not both. Never automatically cancel existing runs.
- Structured JSON goes to stdout/journal. Exit 2 denotes an actionable fault; no outgoing test alert is sent. The deployment owner must wire an approved existing monitoring destination; none is silently installed here.

The production token must be dedicated to **this one repository**, fine-grained **Actions: write** (metadata read is implicit; public contents are readable). Do not copy a broad developer token, mint a key from another credential, put it in the repository, pass it on a command line, or print it. Supply it only via the administrator's approved secret input as `DIVIDEND_ACTIONS_TOKEN`. Rotate/revoke it through its normal provider flow. No credential was created or extracted for this change.

## Existing Grok Bot box routine (no new credential)

An authorized routine can execute `node scripts/market-watchdog.mjs --github-cli --dispatch --monitor` using the existing `gh` session. This uses the same public official API and fixed repository boundary, **does not read or export the CLI credential**, and writes its persistent dedup state outside the checkout (set `DIVIDEND_WATCHDOG_STATE`). This option is for the existing box only, not permission to copy the account session to Tencent. Authentication failures stop safely; repeated auth failures should pause the routine and request normal reconnection. The routine must still be explicitly saved by the parent with its actual schedule/result, not inferred from this document. On a persistent snapshot/auth/ambiguous-dispatch error, wake the parent in the user's original chat; do not send an external test message. Keep only one active external authority.

## Tencent Cloud install acceptance (administrator only)

Use a separate `/opt/tangping-dividend` checkout/read-only release directory and Node >=22. Review `deploy/tangping-market-watchdog.service` and `.timer`, then install those units through the approved administration channel. Supply `/etc/tangping-market-watchdog.env` root-owned mode 0600 with the dedicated token; the unit is a DynamicUser sandbox with a private StateDirectory, not a web-server user. Do not touch nginx/PHP/other app directories. Enable only this timer after authorization.

Timer: `08:30 Asia/Shanghai` daily, persistent catch-up after host downtime. Saturday is intentional: Friday US close lands on Saturday Beijing; Sunday/Monday checks normally no-op. Accuracy 30 seconds is not a real-time SLA. Service is capped at 22 minutes, uses an exclusive lock, maximum two confirmed-failure attempts, no endless retry. No GitHub cron was added.

Acceptance evidence: Node version; `systemd-analyze calendar '*-*-* 08:30:00 Asia/Shanghai'`; `systemd-analyze verify` for both units; successful read-only checker; sandboxed fresh-data `--dispatch --monitor` no-op; `systemctl list-timers` next trigger; service journal; private state ownership. Observe the **next real 08:30 execution** before claiming scheduled delivery. Check provider credential expiry and alert on missing daily guard heartbeat. A stale lock after SIGKILL requires operator confirmation that no service runs before removal; fail closed rather than creating a duplicate.

Rollback: disable/remove only this timer/service using the approved administrator channel; revoke only its dedicated Actions credential; preserve state/journal as evidence. Repository rollback uses a normal revert, never force push, and does not revert fresh market data.

## Original regression found during acceptance

The previous CHPY release regression read the moving production snapshot while asserting the 2026-11-11 price. It necessarily fails after any real price update. The original exact 52-week/amount checks now use an authentic fixture from release merge `7725e09321e3f5686c6afa242a46cb0d9e15ced2`; a separate live snapshot invariant checks the actual trailing-365-day sum, rate, unique ex-dates and retained older history. No dividend values were modified to make a test pass.
