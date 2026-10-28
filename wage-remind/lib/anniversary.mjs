import { assertDate } from "./time.mjs";

export const DEFAULT_WORK_STARTED_ON = "2019-08-01";
export const DEFAULT_TEN_YEAR_ON = "2029-08-01";

export function calendarDaysBetween(from, to) {
  assertDate(from);
  assertDate(to);
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number);
  const [toYear, toMonth, toDay] = to.split("-").map(Number);
  const ms = Date.UTC(toYear, toMonth - 1, toDay) - Date.UTC(fromYear, fromMonth - 1, fromDay);
  return Math.round(ms / 86400000);
}

function addMonths(date, months) {
  const year = Number(date.slice(0, 4));
  const monthIndex = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const total = year * 12 + monthIndex + months;
  const nextYear = Math.floor(total / 12);
  const nextMonthIndex = total % 12;
  const lastDay = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate();
  const nextDay = Math.min(day, lastDay);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonthIndex + 1).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
}

export function calendarElapsed(from, to) {
  assertDate(from);
  assertDate(to);
  if (to < from) return { years: 0, months: 0, days: 0 };
  let years = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  if (addMonths(from, years * 12) > to) years -= 1;
  let months = 0;
  while (months < 12 && addMonths(from, years * 12 + months + 1) <= to) months += 1;
  return { years, months, days: calendarDaysBetween(addMonths(from, years * 12 + months), to) };
}

export function formatElapsed(elapsed) {
  return `${elapsed.years}年${elapsed.months}个月${elapsed.days}天`;
}

export function normalizeAnniversary(raw = {}) {
  const startedOn = raw.startedOn || DEFAULT_WORK_STARTED_ON;
  const tenYearOn = raw.tenYearOn || DEFAULT_TEN_YEAR_ON;
  assertDate(startedOn);
  assertDate(tenYearOn);
  if (tenYearOn <= startedOn) throw new Error("十周年日期必须晚于开始上班日期");
  return { startedOn, tenYearOn };
}

export function describeAnniversary(today, raw) {
  const { startedOn, tenYearOn } = normalizeAnniversary(raw);
  assertDate(today);
  const daysLeft = calendarDaysBetween(today, tenYearOn);
  const elapsed = calendarElapsed(startedOn, today);
  if (daysLeft > 0) return { phase: "before", daysLeft, elapsed, startedOn, tenYearOn };
  if (daysLeft === 0) return { phase: "today", daysLeft: 0, elapsed, startedOn, tenYearOn };
  return { phase: "after", daysLeft: null, elapsed, startedOn, tenYearOn };
}

export function countdownLine(status) {
  if (status.phase === "after") return "上班十周年已达成";
  if (status.phase === "today") return "上班十周年：今天";
  return `距离上班十周年：还有${status.daysLeft}天`;
}

export function tenureLine(status) {
  return `已工作：${formatElapsed(status.elapsed)}`;
}
