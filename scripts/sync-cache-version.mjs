import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSIONED_FILES = ["index.html", "app.js", "market-data.js", "manifest.webmanifest"];

export function applyCacheQuery(source, version) {
  return source.replace(/\?v=\d+\.\d+(?:\.\d+)?/g, `?v=${version}`);
}

export function applyReleaseConstant(source, version) {
  if (!source.includes("export const APP_VERSION = ")) throw new Error("pwa-release.js is missing APP_VERSION");
  return source.replace(/export const APP_VERSION = "[^"]+";/, `export const APP_VERSION = "${version}";`);
}

export async function syncCacheVersion({ write = true } = {}) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`package.json version must be x.y.z, got ${pkg.version}`);
  const releasePath = join(root, "pwa-release.js");
  const releaseBefore = await readFile(releasePath, "utf8");
  const release = applyReleaseConstant(releaseBefore, pkg.version);
  const files = [];
  for (const name of VERSIONED_FILES) {
    const path = join(root, name);
    const before = await readFile(path, "utf8");
    const after = applyCacheQuery(before, pkg.version);
    files.push({ name, changed: before !== after });
    if (write && before !== after) await writeFile(path, after);
  }
  const releaseChanged = release !== releaseBefore;
  if (write && releaseChanged) await writeFile(releasePath, release);
  return { version: pkg.version, releaseChanged, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await syncCacheVersion();
  const changed = result.releaseChanged || result.files.some((file) => file.changed);
  console.log(changed ? `cache version synced to ${result.version}` : `cache version already ${result.version}`);
}
