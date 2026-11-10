import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

export function commitMarketSnapshot({ cwd = process.cwd(), branch = process.env.DEFAULT_BRANCH || "main", file = "data/market.json" } = {}) {
  git(["config", "user.name", "github-actions[bot]"], cwd);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], cwd);
  const added = git(["add", "--", file], cwd);
  if (added.status !== 0) throw new Error((added.stderr || "git add failed").trim());
  const staged = git(["diff", "--cached", "--quiet", "--", file], cwd);
  if (staged.status === 0) {
    console.log("No snapshot changes; no commit created.");
    return { committed: false, pushed: false };
  }
  if (staged.status !== 1) throw new Error((staged.stderr || "git diff failed").trim());
  const snapshot = JSON.parse(readFileSync(resolve(cwd, file), "utf8"));
  const day = snapshot.refresh?.target_price_date || "unknown";
  const held = [...new Set(Object.values(snapshot.symbols || {}).map((row) => row.price?.price_date).filter(Boolean))].join(",");
  const current = snapshot.refresh?.freshness === "current";
  const message = current ? `chore: update public market snapshot (${day})` : `chore: update public market snapshot (stale, expected ${day}, held ${held})`;
  const committed = git(["commit", "-m", message, "--", file], cwd);
  if (committed.status !== 0) throw new Error((committed.stderr || committed.stdout || "git commit failed").trim());
  const pulled = git(["pull", "--rebase", "origin", branch], cwd);
  if (pulled.status !== 0) throw new Error((pulled.stderr || pulled.stdout || "git pull --rebase failed").trim());
  const pushed = git(["push", "origin", `HEAD:${branch}`], cwd);
  if (pushed.status !== 0) throw new Error((pushed.stderr || pushed.stdout || "git push failed").trim());
  console.log(committed.stdout.trim());
  return { committed: true, pushed: true, message };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    commitMarketSnapshot();
  } catch (error) {
    console.error(error?.message || "snapshot publish failed");
    process.exitCode = 1;
  }
}
