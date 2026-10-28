import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function emptyState() {
  return { version: 1, sent: {}, recent: [] };
}

export async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || parsed.version !== 1 || typeof parsed.sent !== "object" || !Array.isArray(parsed.recent)) {
      return emptyState();
    }
    return { version: 1, sent: parsed.sent, recent: parsed.recent };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}

export function slotRecord(state, date, slot) {
  return state.sent?.[date]?.[slot] || null;
}

export function withSlot(state, date, slot, record) {
  const day = { ...(state.sent[date] || {}), [slot]: record };
  return { ...state, sent: { ...state.sent, [date]: day } };
}

export function rememberCopy(recent, entry) {
  const next = recent.filter((item) => !(item.date === entry.date && item.slot === entry.slot));
  next.push({ date: entry.date, slot: entry.slot, id: entry.id });
  return next.slice(-80);
}
