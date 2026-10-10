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

const LITERAL_QUERY = /\?v=(\d+\.\d+(?:\.\d+)?)/g;

// Returns human-readable problems. Empty means package.json, the service
// worker cache name, every shipped ?v= token, and manifest start_url agree.
export function findVersionDrift(version, files) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json version must be x.y.z, got ${version}`);
  const release = files["pwa-release.js"] || "";
  const sw = files["sw.js"] || "";
  if (!release.includes(`export const APP_VERSION = "${version}";`)) problems.push("pwa-release.js APP_VERSION does not match package.json");
  if (!release.includes("export const APP_CACHE = `tangping-dividend-v${APP_VERSION}`;")) problems.push("APP_CACHE is not derived from APP_VERSION");
  if (!sw.includes("const CACHE_NAME = APP_CACHE;")) problems.push("sw.js cache name is not APP_CACHE");
  if (!sw.includes('from "./pwa-release.js"')) problems.push("sw.js does not import pwa-release.js");
  let manifest;
  try { manifest = JSON.parse(files["manifest.webmanifest"] || ""); }
  catch { problems.push("manifest.webmanifest is not JSON"); }
  if (manifest && manifest.start_url !== `./?v=${version}`) problems.push(`manifest start_url is ${manifest.start_url}, expected ./?v=${version}`);
  for (const name of ["index.html", "app.js", "market-data.js", "manifest.webmanifest"]) {
    const source = files[name] || "";
    const found = [...source.matchAll(LITERAL_QUERY)].map((match) => match[1]);
    if (!found.length) problems.push(`${name} has no ?v=${version} token`);
    for (const token of found) if (token !== version) problems.push(`${name} has ?v=${token}`);
  }
  for (const name of ["sw.js", "pwa-release.js", "market-calendar.js"]) {
    for (const token of (files[name] || "").matchAll(LITERAL_QUERY)) {
      problems.push(`${name} hardcodes ?v=${token[1]}`);
    }
  }
  return problems;
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

export async function readShippedSources() {
  const names = ["pwa-release.js", "sw.js", "market-calendar.js", ...VERSIONED_FILES];
  const files = {};
  for (const name of names) files[name] = await readFile(join(root, name), "utf8");
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const problems = findVersionDrift(pkg.version, await readShippedSources());
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`cache version ${pkg.version} matches service worker, ?v= tokens, and manifest start_url`);
  } else {
    const result = await syncCacheVersion();
    const changed = result.releaseChanged || result.files.some((file) => file.changed);
    console.log(changed ? `cache version synced to ${result.version}` : `cache version already ${result.version}`);
  }
}
