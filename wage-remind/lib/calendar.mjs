import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertDate, weekdayOf } from "./time.mjs";

export async function loadHolidayDirectory(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const files = [];
  for (const name of names) {
    files.push(JSON.parse(await readFile(join(dir, name), "utf8")));
  }
  return files;
}

export function loadCalendar(files, overrides = []) {
  const byDate = new Map();
  const years = new Set();
  for (const file of files) {
    if (!file || !Number.isInteger(file.year) || !Array.isArray(file.days) || file.days.length === 0) {
      throw new Error("节假日文件无效或为空");
    }
    years.add(file.year);
    for (const day of file.days) {
      const date = assertDate(day.date);
      if (Number(date.slice(0, 4)) !== file.year) throw new Error(`${date} 不属于 ${file.year} 年日历`);
      if (typeof day.isOffDay !== "boolean") throw new Error(`${date} 缺少 isOffDay`);
      byDate.set(date, { name: String(day.name || "节假日"), isOffDay: day.isOffDay });
    }
  }
  for (const day of overrides) {
    const date = assertDate(day.date);
    if (typeof day.isOffDay !== "boolean") throw new Error(`${date} 的手动覆盖缺少 isOffDay`);
    byDate.set(date, { name: String(day.name || "手动覆盖"), isOffDay: day.isOffDay });
  }
  return { byDate, years };
}

export function assertYearCovered(calendar, year) {
  if (!calendar.years.has(year)) {
    throw new Error(`缺少 ${year} 年法定节假日数据。请更新 wage-remind/data/holidays/${year}.json`);
  }
}

export function classifyDate(date, calendar) {
  assertDate(date);
  assertYearCovered(calendar, Number(date.slice(0, 4)));
  const entry = calendar.byDate.get(date);
  if (entry?.isOffDay) return { date, work: false, kind: "holiday", name: entry.name };
  if (entry && entry.isOffDay === false) return { date, work: true, kind: "makeup", name: entry.name };
  const weekend = weekdayOf(date) === 0 || weekdayOf(date) === 6;
  return weekend
    ? { date, work: false, kind: "weekend", name: "" }
    : { date, work: true, kind: "weekday", name: "" };
}
