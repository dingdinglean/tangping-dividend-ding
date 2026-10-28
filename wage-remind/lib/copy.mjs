import { readFile } from "node:fs/promises";

const PRIORITY = ["month_end", "pre_holiday", "friday", "wednesday", "monday", "anniversary"];

export async function loadCopyLibrary(path) {
  const library = JSON.parse(await readFile(path, "utf8"));
  for (const slot of ["morning", "evening"]) {
    if (!Array.isArray(library[slot]) || library[slot].length < 50) {
      throw new Error(`${slot} 文案不足 50 条`);
    }
    const ids = new Set();
    const texts = new Set();
    for (const line of library[slot]) {
      if (!line.id || !line.text || !Array.isArray(line.tags) || line.tags.length === 0) {
        throw new Error("文案缺少 id、正文或标签");
      }
      if (ids.has(line.id) || texts.has(line.text)) throw new Error(`文案重复: ${line.id}`);
      ids.add(line.id);
      texts.add(line.text);
    }
  }
  return library;
}

export function hashText(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function selectCopy(lines, { date, slot, contexts, recent }) {
  const history = recent.filter((item) => item.slot === slot);
  const today = history.find((item) => item.date === date);
  if (today) {
    const same = lines.find((line) => line.id === today.id);
    if (same) return same;
  }
  const excluded = new Set(history.filter((item) => item.date !== date).slice(-14).map((item) => item.id));
  const available = lines.filter((line) => !excluded.has(line.id));
  let pool = [];
  for (const tag of PRIORITY) {
    if (!contexts.includes(tag)) continue;
    const matched = available.filter((line) => line.tags.includes(tag));
    if (matched.length > 0) {
      pool = matched;
      break;
    }
  }
  if (pool.length === 0) {
    pool = available.filter((line) => line.tags.includes("general") || line.tags.includes("humor"));
  }
  if (pool.length === 0) pool = available;
  if (pool.length === 0) throw new Error("文案库不足以保证连续 14 个工作日不重复");
  return pool[hashText(`${date}:${slot}`) % pool.length];
}
