import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi, createGhApi, decide, inspectSnapshot, watchdog, REPOSITORY, SYMBOLS } from "../scripts/market-watchdog.mjs";
const now = Date.parse("2026-11-24T00:30:00Z");
const snapshot = (date = "2026-11-23") => ({ schemaVersion: 2, generatedAt: new Date(now).toISOString(), symbols: Object.fromEntries(SYMBOLS.map(symbol => [symbol, { price: { price: 10, price_date: date }, price_status: "valid", dividends: { data: [{ ex_date: "2026-11-18", amount: 0.3 }] } }])) });
const run = (overrides = {}) => ({ id: 100, head_branch: "main", status: "completed", conclusion: "failure", event: "workflow_dispatch", created_at: "2026-11-24T00:20:00Z", ...overrides });
const decision = (overrides = {}) => decide({ snapshot: snapshot("2026-11-20"), runs: [], now, ...overrides });
test("all six close dates, not generated timestamp, determine freshness", () => {
  assert.equal(decision({ snapshot: snapshot() }).action, "fresh");
  assert.equal(decision().action, "dispatch");
  const partial = snapshot(); partial.symbols.CHPY.price.price_date = "2026-11-20";
  assert.deepEqual(decision({ snapshot: partial }).stale, ["CHPY"]);
});
for (const status of ["queued", "in_progress", "requested", "waiting", "pending"]) test(`suppress dispatch for ${status}`, () => {
  assert.equal(decision({ runs: [run({ status })] }).action, "running");
});
test("other branch never suppresses main; stuck main is an alert", () => {
  assert.equal(decision({ runs: [run({ head_branch: "other", status: "queued" })] }).action, "dispatch");
  assert.equal(decision({ runs: [run({ status: "in_progress", created_at: "2026-11-23T10:00:00Z" })] }).alert, true);
});
test("successful same-session run with stale data alerts, not duplicates", () => {
  assert.equal(decision({ runs: [run({ conclusion: "success" })] }).reason, "successful_run_but_snapshot_stale");
  assert.equal(decision({ runs: [run({ conclusion: "success", created_at: "2026-11-21T07:00:00Z" })] }).action, "dispatch");
});
for (const status of ["unknown", "intent"]) test(`durable ${status} never blindly repeats POST`, () => {
  assert.equal(decision({ state: { expected: "2026-11-23", attempts: [{ status }] } }).reason, "dispatch_acceptance_unknown");
});
test("accepted dispatch missing from API alerts", () => {
  assert.equal(decision({ state: { expected: "2026-11-23", attempts: [{ status: "accepted", baseline: 50, at: "2026-11-24T00:20:00Z" }] } }).reason, "accepted_run_not_visible");
});
test("one confirmed failed run allows one bounded retry, never a third", () => {
  const attempt = { status: "accepted", baseline: 50, at: "2026-11-24T00:19:59Z" };
  assert.equal(decision({ runs: [run()], state: { expected: "2026-11-23", attempts: [attempt] } }).action, "dispatch");
  assert.equal(decision({ runs: [run()], state: { expected: "2026-11-23", attempts: [attempt, attempt] } }).reason, "session_retry_limit");
  assert.equal(decision({ state: { expected: "2026-11-20", attempts: [attempt, attempt] } }).action, "dispatch");
});
for (const [time, expected] of [
  ["2026-11-23T00:30:00Z", "2026-11-20"], // Monday Beijing/weekend US
  ["2026-11-27T00:30:00Z", "2026-11-25"], // Thanksgiving
  ["2026-11-27T18:01:00Z", "2026-11-27"], // half day close 13 ET
  ["2026-07-07T00:30:00Z", "2026-07-06"], // DST
  ["2026-03-09T00:30:00Z", "2026-03-06"], // DST transition weekend
]) test(`reuse exchange calendar ${time}`, () => {
  assert.equal(decision({ now: Date.parse(time), snapshot: snapshot(expected) }).expected, expected);
});
for (const mutate of [s => delete s.symbols.XQQI, s => { s.symbols.CHPY.dividends.data = []; }, s => { s.symbols.QQQI.price.price = 0; }, s => { s.symbols.QQQI.price.price_date = "2026-11-25"; }]) test("invalid evidence fails closed", () => {
  const s = snapshot(); mutate(s); assert.throws(() => inspectSnapshot(s, "2026-11-23"), /invalid_snapshot/);
});
function fakeApi({ stale = true, racing = false, failPost = false } = {}) {
  let reads = 0; const posts = [];
  const api = async (path, options = {}) => {
    if (options.method === "POST") { posts.push(options); if (failPost) throw new Error("secret-not-logged"); return null; }
    if (path.includes("/contents/")) { reads++; return { encoding: "base64", content: Buffer.from(JSON.stringify(snapshot(stale && !(racing && reads > 1) ? "2026-11-20" : "2026-11-23"))).toString("base64") }; }
    if (path.includes("/runs?")) return { total_count: 0, workflow_runs: [] };
    return { state: "active", path: ".github/workflows/update-market-data.yml" };
  };
  return { api, posts };
}
async function temporary(fn) { const dir = await mkdtemp(join(tmpdir(), "market-watchdog-")); try { await fn(join(dir, "state.json")); } finally { await rm(dir, { recursive: true, force: true }); } }
test("dry run never posts; real mock dispatch persists intent and deduplicates", () => temporary(async statePath => {
  const { api, posts } = fakeApi();
  assert.equal((await watchdog({ api, statePath, now })).action, "dispatch"); assert.equal(posts.length, 0);
  assert.equal((await watchdog({ api, statePath, now, dispatch: true })).action, "dispatched");
  assert.equal(JSON.parse(await readFile(statePath)).attempts[0].status, "accepted");
  assert.equal((await watchdog({ api, statePath, now, dispatch: true })).action, "alert"); assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { ref: "main" });
}));
test("recheck wins race against existing cron completion", () => temporary(async statePath => {
  const { api, posts } = fakeApi({ racing: true });
  assert.equal((await watchdog({ api, statePath, now, dispatch: true })).action, "fresh"); assert.equal(posts.length, 0);
}));
test("concurrent instances lock and ambiguous dispatch is durable", () => temporary(async statePath => {
  const { api, posts } = fakeApi({ failPost: true });
  await writeFile(`${statePath}.lock`, "");
  assert.equal((await watchdog({ api, statePath, now, dispatch: true })).action, "locked"); assert.equal(posts.length, 0);
  await rm(`${statePath}.lock`);
  assert.equal((await watchdog({ api, statePath, now, dispatch: true })).reason, "dispatch_acceptance_unknown");
  assert.equal(JSON.parse(await readFile(statePath)).attempts[0].status, "unknown");
  await watchdog({ api, statePath, now, dispatch: true }); assert.equal(posts.length, 1);
}));
test("corrupted state is never overwritten", () => temporary(async statePath => {
  await writeFile(statePath, "bad"); const { api, posts } = fakeApi();
  await assert.rejects(watchdog({ api, statePath, now, dispatch: true }), /state_invalid/); assert.equal(posts.length, 0);
}));
test("safe API retries GET, not POST; fixed repository boundary", async () => {
  let calls = 0; const fetcher = async () => { calls++; return new Response("", { status: 503 }); };
  const api = createApi({ fetcher, waiter: async () => {} });
  await assert.rejects(api(`/repos/${REPOSITORY}/x`), /github_http_503/); assert.equal(calls, 3);
  calls = 0; await assert.rejects(api(`/repos/${REPOSITORY}/x`, { method: "POST" }), /github_http_503/); assert.equal(calls, 1);
  await assert.rejects(api("/repos/other/project/x"), /repository_scope_denied/); assert.equal(calls, 1);
});

test("existing gh session transport never extracts secrets and bounds scope/retries", async () => {
  const calls = [];
  const api = createGhApi({ runner: (command, args, opts) => { calls.push({ command, args, opts }); return { status: 0, stdout: args.includes("POST") ? "" : '{"ok":true}' }; } });
  assert.deepEqual(await api(`/repos/${REPOSITORY}/contents/data/market.json`), { ok: true });
  assert.equal(await api(`/repos/${REPOSITORY}/actions/workflows/350907457/dispatches`, { method: "POST", body: { ref: "main" } }), null);
  assert.equal(calls[0].command, "gh");
  assert.equal(calls[0].opts.timeout, 20000);
  assert.deepEqual(JSON.parse(calls[1].opts.input), { ref: "main" });
  assert.equal(calls[1].args.includes("--input"), true);
  await assert.rejects(api("/user"), /repository_scope_denied/);
  assert.equal(calls.length, 2);
});
test("gh POST errors are not repeated or logged, GET retry is bounded", async () => {
  let count = 0;
  const api = createGhApi({ runner: () => { count++; return { status: 1, stderr: "PRIVATE" }; }, waiter: async () => {} });
  await assert.rejects(api(`/repos/${REPOSITORY}/x`, { method: "POST" }), /dispatch_acceptance_unknown/);
  assert.equal(count, 1);
  await assert.rejects(api(`/repos/${REPOSITORY}/x`), /github_cli_failed/);
  assert.equal(count, 4);
});
