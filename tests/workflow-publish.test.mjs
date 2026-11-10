import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitMarketSnapshot } from "../scripts/commit-market-snapshot.mjs";

const workflow = await readFile(new URL("../.github/workflows/update-market-data.yml", import.meta.url), "utf8");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result.stdout;
}

test("the market workflow keeps the two official crons, one compensation, and a visible failure", () => {
  assert.match(workflow, /cron: '5 18 \* \* 1-5'/);
  assert.match(workflow, /cron: '40 22 \* \* 1-5'/);
  assert.match(workflow, /cron: '17 0 \* \* 2-6'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /github\.event\.schedule/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/update-market-data\.mjs/);
  assert.match(workflow, /node scripts\/commit-market-snapshot\.mjs/);
  assert.match(workflow, /steps\.refresh\.outcome != 'success'/);
  assert.equal(workflow.includes("continue-on-error"), false);
  assert.equal((workflow.match(/cron:/g) || []).length, 3);
});

test("an unchanged snapshot is not committed and a rejected push leaves the published file", async () => {
  const root = await mkdtemp(join(tmpdir(), "publish-"));
  const bare = join(root, "bare.git");
  const work = join(root, "work");
  git(["init", "--bare", "-b", "main", bare], root);
  await chmod(join(bare, "hooks", "pre-receive"), 0o755).catch(() => {});
  git(["clone", bare, work], root);
  git(["config", "user.name", "Test"], work);
  git(["config", "user.email", "test@example.com"], work);
  await mkdir(join(work, "data"), { recursive: true });
  const original = `${JSON.stringify({ schemaVersion: 2, refresh: { target_price_date: "2026-11-06", freshness: "current" }, symbols: {} }, null, 2)}\n`;
  await writeFile(join(work, "data", "market.json"), original);
  await writeFile(join(work, "README.md"), "leave me\n");
  git(["add", "data/market.json", "README.md"], work);
  git(["commit", "-m", "base"], work);
  git(["push", "origin", "HEAD:main"], work);
  const unchanged = commitMarketSnapshot({ cwd: work, branch: "main" });
  assert.equal(unchanged.committed, false);
  assert.equal(git(["rev-list", "--count", "HEAD"], work).trim(), "1");
  await writeFile(join(work, "data", "market.json"), original.replace("2026-11-06", "2026-11-09"));
  await writeFile(join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho push rejected >&2\nexit 1\n");
  await chmod(join(bare, "hooks", "pre-receive"), 0o755);
  assert.throws(() => commitMarketSnapshot({ cwd: work, branch: "main" }), /push rejected/);
  const published = git(["--git-dir", bare, "show", "main:data/market.json"], root);
  assert.match(published, /2026-11-06/);
  assert.doesNotMatch(published, /2026-11-09/);
  assert.equal(git(["show", "HEAD:README.md"], work), "leave me\n");
  const names = git(["show", "--name-only", "--format=", "HEAD"], work).trim().split("\n");
  assert.deepEqual(names, ["data/market.json"]);
});
