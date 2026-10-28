import { allocateCents } from "./money.mjs";
import { classifyDate } from "./calendar.mjs";
import { assertDate, datesInMonth } from "./time.mjs";

const KINDS = new Set(["paid_leave", "unpaid_leave", "rest", "work", "overtime"]);

export function indexAdjustments(adjustments = []) {
  const map = new Map();
  for (const raw of adjustments) {
    const date = assertDate(raw.date);
    if (!KINDS.has(raw.kind)) throw new Error(`未知的调整类型: ${raw.kind}`);
    if (map.has(date)) throw new Error(`同一天只能有一条调整: ${date}`);
    const entry = { date, kind: raw.kind };
    if (raw.kind === "overtime") {
      const cents = raw.cents ?? 0;
      if (!Number.isInteger(cents) || cents < 0) {
        throw new Error("加班金额必须是非负整数分；省略则为 0，不会自动计算加班费");
      }
      entry.cents = cents;
    } else if (raw.cents != null) {
      throw new Error("只有加班调整可以填写 cents");
    }
    map.set(date, entry);
  }
  return map;
}

export function isSalaryWorkday(date, calendar, adjustments) {
  const adj = adjustments.get(date);
  if (adj?.kind === "paid_leave" || adj?.kind === "unpaid_leave" || adj?.kind === "rest") return false;
  if (adj?.kind === "work") return true;
  return classifyDate(date, calendar).work;
}

export function buildMonthPlan({ year, month, calendar, config, adjustments }) {
  const monthlyNetCents = config.monthlyNetCents;
  const dates = datesInMonth(year, month);
  const calendarWork = dates.filter((date) => classifyDate(date, calendar).work);
  const originalShares = allocateCents(monthlyNetCents, calendarWork.length);
  const originalByDate = new Map(calendarWork.map((date, index) => [date, originalShares[index]]));

  let pool = monthlyNetCents;
  const final = [];
  for (const date of calendarWork) {
    const kind = adjustments.get(date)?.kind;
    if (kind === "paid_leave") {
      if (!config.paidLeaveKeepsSalary) pool -= originalByDate.get(date);
      continue;
    }
    if (kind === "unpaid_leave") {
      pool -= originalByDate.get(date);
      continue;
    }
    if (kind === "rest") continue;
    final.push(date);
  }
  for (const [date, adj] of adjustments) {
    if (adj.kind === "work" && date.startsWith(`${year}-${String(month).padStart(2, "0")}-`) && !calendarWork.includes(date)) {
      final.push(date);
    }
  }
  final.sort();
  if (pool < 0) throw new Error("请假扣减超过了月薪");
  if (final.length === 0) throw new Error("本月没有计薪工作日，无法分配月薪");

  const shares = allocateCents(pool, final.length);
  const workdays = final.map((date, index) => ({
    date,
    cents: shares[index],
    overtimeCents: adjustments.get(date)?.kind === "overtime" ? adjustments.get(date).cents : 0,
  }));
  const workdaySet = new Set(final);
  const offDayOvertime = [];
  for (const [date, adj] of adjustments) {
    if (adj.kind !== "overtime" || workdaySet.has(date) || adj.cents === 0) continue;
    if (!date.startsWith(`${year}-${String(month).padStart(2, "0")}-`)) continue;
    offDayOvertime.push({ date, cents: 0, overtimeCents: adj.cents });
  }
  offDayOvertime.sort((a, b) => a.date.localeCompare(b.date));
  return { year, month, monthlyNetCents, pool, originalByDate, workdays, offDayOvertime };
}

export function totalsThrough(plan, date) {
  let before = 0;
  let today = 0;
  for (const row of [...plan.workdays, ...plan.offDayOvertime]) {
    const amount = row.cents + row.overtimeCents;
    if (row.date < date) before += amount;
    else if (row.date === date) today += amount;
  }
  return {
    before,
    today,
    remaining: plan.workdays.filter((row) => row.date > date).length,
    baseSum: plan.workdays.reduce((sum, row) => sum + row.cents, 0),
  };
}

export function isLastWorkday(plan, date) {
  return plan.workdays.at(-1)?.date === date;
}
