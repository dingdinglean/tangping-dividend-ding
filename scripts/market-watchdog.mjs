// Independent clock, existing updater. No market data is ever written here.
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { cashCloseUtc, latestCompletedUsTradingSession } from "../market-calendar.js";

export const REPOSITORY = "dingdinglean/tangping-dividend-ding";
export const WORKFLOW = "350907457";
export const SYMBOLS = ["QQQI", "SPYI", "XQQI", "QNDX", "SCHD", "CHPY"];
const ACTIVE = new Set(["queued", "in_progress", "requested", "waiting", "pending"]);
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
export function inspectSnapshot(snapshot, expected) {
  if (snapshot?.schemaVersion !== 2 || !Number.isFinite(Date.parse(snapshot?.generatedAt))) throw new Error("invalid_snapshot");
  return SYMBOLS.filter(symbol => {
    const row = snapshot.symbols?.[symbol];
    if (!row || !Number.isFinite(Number(row.price?.price)) || Number(row.price.price) <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(row.price.price_date || "") || row.price.price_date > expected ||
        !Array.isArray(row.dividends?.data) || !row.dividends.data.some(d => Number.isFinite(d.amount) && d.amount >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(d.ex_date || ""))) throw new Error("invalid_snapshot");
    return row.price.price_date !== expected || row.price_status !== "valid";
  });
}
export function decide({ snapshot, runs, state = {}, now = Date.now() }) {
  const expected = latestCompletedUsTradingSession(now).date;
  const stale = inspectSnapshot(snapshot, expected);
  const base = { expected, stale };
  if (!stale.length) return { ...base, action: "fresh" };
  const relevant = runs.filter(r => r.head_branch === "main");
  const active = relevant.find(r => ACTIVE.has(r.status));
  if (active) return { ...base, action: "running", run: active.id, alert: now - Date.parse(active.created_at) > 6 * 3600000 };
  const attempts = state.expected === expected ? state.attempts || [] : [];
  const last = attempts.at(-1);
  if (last) {
    // No POST retry after timeout/5xx: the server may have accepted it.
    if (last.status === "unknown" || last.status === "intent") return { ...base, action: "alert", reason: "dispatch_acceptance_unknown" };
    const run = relevant.find(r => r.event === "workflow_dispatch" && r.id > last.baseline && Date.parse(r.created_at) >= Date.parse(last.at) - 5000);
    if (!run) return { ...base, action: "alert", reason: "accepted_run_not_visible" };
    if (run.conclusion === "success") return { ...base, action: "alert", reason: "successful_run_but_snapshot_stale", run: run.id };
    if (!FAILED.has(run.conclusion)) return { ...base, action: "alert", reason: "unresolved_run", run: run.id };
    if (attempts.length >= 2) return { ...base, action: "alert", reason: "session_retry_limit", run: run.id };
    if (now - Date.parse(last.at) < 60000) return { ...base, action: "running", run: run.id };
  } else {
    const earliest = cashCloseUtc(expected).closeAt - 8 * 3600000;
    const success = relevant.find(r => r.conclusion === "success" && Date.parse(r.created_at) >= earliest);
    if (success) return { ...base, action: "alert", reason: "successful_run_but_snapshot_stale", run: success.id };
  }
  return { ...base, action: "dispatch" };
}
export function createApi({ token = "", fetcher = fetch, waiter = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async function api(path, { method = "GET", body } = {}) {
    if (!path.startsWith(`/repos/${REPOSITORY}/`)) throw new Error("repository_scope_denied");
    // GET can retry; dispatch never retries an ambiguous network response.
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(`https://api.github.com${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(20000),
          headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "tangping-market-watchdog", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        if (method !== "GET" || attempt === 2) throw new Error(method === "GET" ? "github_network_error" : "dispatch_acceptance_unknown");
        await waiter(1000 * (attempt + 1)); continue;
      }
      if (!response.ok) {
        if (method === "GET" && response.status >= 500 && attempt < 2) { await waiter(1000 * (attempt + 1)); continue; }
        // Response bodies are deliberately not logged (may contain private metadata).
        throw new Error(`github_http_${response.status}`);
      }
      return response.status === 204 ? null : response.json();
    }
  };
}
// For an authorized Grok Bot routine on the existing box only. Use gh's
// normal authenticated session without reading/exporting any credential.
// Do not copy that developer session onto a production server.
export function createGhApi({ runner = spawnSync, waiter = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async (path, { method = "GET", body } = {}) => {
    if (!path.startsWith(`/repos/${REPOSITORY}/`)) throw new Error("repository_scope_denied");
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = runner("gh", ["api", path, "--method", method, ...(body ? ["--input", "-"] : [])], {
        encoding: "utf8", timeout: 20000, maxBuffer: 4 * 1024 * 1024,
        ...(body ? { input: JSON.stringify(body) } : {}),
      });
      if (!result.error && result.status === 0) return result.stdout.trim() ? JSON.parse(result.stdout) : null;
      if (method !== "GET" || attempt === 2) throw new Error(method === "GET" ? "github_cli_failed" : "dispatch_acceptance_unknown");
      await waiter(1000 * (attempt + 1));
    }
  };
}
export async function readEvidence(api, now = Date.now()) {
  const since = new Date(cashCloseUtc(latestCompletedUsTradingSession(now).date).closeAt - 8 * 3600000).toISOString();
  const root = `/repos/${REPOSITORY}`;
  const [file, workflow, listed, ...activeLists] = await Promise.all([
    api(`${root}/contents/data/market.json?ref=main`),
    api(`${root}/actions/workflows/${WORKFLOW}`),
    api(`${root}/actions/workflows/${WORKFLOW}/runs?branch=main&created=${encodeURIComponent(`>=${since}`)}&per_page=100`),
    // Do not miss old sleeping, queued, waiting-for-approval, or pending runs.
    ...[...ACTIVE].map(status => api(`${root}/actions/workflows/${WORKFLOW}/runs?branch=main&status=${status}&per_page=100`)),
  ]);
  if (workflow.state !== "active" || workflow.path !== ".github/workflows/update-market-data.yml") throw new Error("workflow_not_active");
  if ([listed, ...activeLists].some(list => list.total_count > 100)) throw new Error("run_history_overflow");
  if (file.encoding !== "base64") throw new Error("invalid_snapshot_encoding");
  const snapshot = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  return { snapshot, runs: [...new Map([...listed.workflow_runs, ...activeLists.flatMap(list => list.workflow_runs)].map(r => [r.id, r])).values()] };
}
async function saveState(path, state) {
  await writeFile(`${path}.tmp`, JSON.stringify(state) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
export async function watchdog({ statePath, api, dispatch = false, now = Date.now() }) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(`${statePath}.lock`, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") return { action: "locked", alert: true }; throw e; }
  try {
    let state = {};
    try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("state_invalid"); }
    const evidence = await readEvidence(api, now);
    const decision = decide({ ...evidence, state, now });
    if (decision.action !== "dispatch" || !dispatch) return { ...decision, dryRun: !dispatch };
    // Re-read immediately before dispatch so a completed/queued cron wins.
    const latest = await readEvidence(api, now);
    const checked = decide({ ...latest, state, now });
    if (checked.action !== "dispatch") return checked;
    if (state.expected !== checked.expected) state = { expected: checked.expected, attempts: [] };
    const attempt = { at: new Date(now).toISOString(), status: "intent", baseline: Math.max(0, ...latest.runs.map(r => r.id)) };
    state.attempts.push(attempt);
    await saveState(statePath, state); // Crash-safe at-most-once intent before network I/O.
    try {
      await api(`/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main" } });
      attempt.status = "accepted";
      await saveState(statePath, state);
      return { ...checked, action: "dispatched", attempt: state.attempts.length };
    } catch {
      attempt.status = "unknown";
      await saveState(statePath, state);
      return { ...checked, action: "alert", reason: "dispatch_acceptance_unknown" };
    }
  } finally { await lock.close(); await unlink(`${statePath}.lock`); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dispatch = process.argv.includes("--dispatch");
    const monitor = process.argv.includes("--monitor");
    const githubCli = process.argv.includes("--github-cli");
    if (dispatch && !githubCli && !process.env.DIVIDEND_ACTIONS_TOKEN) throw new Error("dedicated_actions_token_required");
    const api = githubCli ? createGhApi() : createApi({ token: process.env.DIVIDEND_ACTIONS_TOKEN || "" });
    const statePath = resolve(process.env.DIVIDEND_WATCHDOG_STATE || "./watchdog-state/state.json");
    const deadline = Date.now() + 20 * 60000;
    for (;;) {
      const result = await watchdog({ statePath, api, dispatch });
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      if (result.action === "fresh") break;
      if (!monitor || !dispatch || result.action === "alert" || result.alert || result.action === "locked") { if (result.action === "alert" || result.alert) process.exitCode = 2; break; }
      if (Date.now() >= deadline) { console.error("watchdog_deadline_snapshot_still_stale"); process.exitCode = 2; break; }
      await new Promise(r => setTimeout(r, 30000));
    }
  } catch { console.error("watchdog_failed_check_credentials_network_and_state"); process.exitCode = 2; }
}
