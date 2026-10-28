import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarDaysBetween, calendarElapsed, countdownLine, describeAnniversary, formatElapsed } from "../wage-remind/lib/anniversary.mjs";
import { loadCalendar, loadHolidayDirectory, classifyDate } from "../wage-remind/lib/calendar.mjs";
import { hashText, loadCopyLibrary, selectCopy } from "../wage-remind/lib/copy.mjs";
import { ANNIVERSARY_DAY, CONTEXT_LINES, buildNotificationTitle, buildReminder, isPreHoliday, reminderContexts } from "../wage-remind/lib/message.mjs";
import { formatYuan, ratAdd, ratCmp, ratEq, ratSub, rational, yuanToCents } from "../wage-remind/lib/money.mjs";
import { createLogger, deliverMessage, safeReason } from "../wage-remind/lib/bark.mjs";
import { resolveSlot, run } from "../wage-remind/lib/run.mjs";
import { rememberCopy } from "../wage-remind/lib/state.mjs";
import { shanghaiNow } from "../wage-remind/lib/time.mjs";
import { buildMonthPlan, indexAdjustments, isSalaryWorkday, totalsThrough } from "../wage-remind/lib/wage.mjs";

const root = new URL("..", import.meta.url).pathname;
const holidayDir = join(root, "wage-remind/data/holidays");
const copyPath = join(root, "wage-remind/data/copy.json");
const configPath = join(root, "wage-remind/config.json");

const MONTH_CENTS = yuanToCents(11200);
const DEVICE_KEY = "BkTestKeyDoNotUse0123456789";

function assertNoSecret(text, secret = DEVICE_KEY) {
  assert.equal(String(text ?? "").includes(secret), false);
}

const baseConfig = {
  monthlyNetCents: MONTH_CENTS,
  paidLeaveKeepsSalary: true,
};

function sumBase(plan) {
  return plan.workdays.reduce((total, day) => ratAdd(total, day.cents), rational(0, 1));
}

function sumWithOvertime(plan) {
  return [...plan.workdays, ...plan.offDayOvertime].reduce(
    (total, day) => ratAdd(total, ratAdd(day.cents, rational(day.overtimeCents || 0, 1))),
    rational(0, 1),
  );
}

async function fixtures() {
  const files = await loadHolidayDirectory(holidayDir);
  const calendar = loadCalendar(files);
  const library = await loadCopyLibrary(copyPath);
  const adjustments = indexAdjustments([]);
  return { calendar, library, adjustments };
}

function planFor(calendar, year, month, adjustments = indexAdjustments([]), config = baseConfig) {
  return buildMonthPlan({ year, month, calendar, config, adjustments });
}

function jsonResponse(payload, status = 200) {
  return { status, async text() { return JSON.stringify(payload); } };
}

test("money keeps an exact fraction and rounds only for display", () => {
  assert.equal(yuanToCents(11200), 1120000);
  assert.equal(yuanToCents("11200.5"), 1120050);
  assert.equal(yuanToCents(0.01), 1);
  assert.throws(() => yuanToCents(11200.555), /两位小数/);
  assert.equal(formatYuan(rational(1120000, 18)), "¥622.22");
  assert.equal(formatYuan(rational(15 * 1120000, 18)), "¥9333.33");
  assert.equal(formatYuan(rational(16 * 1120000, 18)), "¥9955.56");
  assert.equal(formatYuan(rational(17 * 1120000, 18)), "¥10577.78");
  assert.equal(formatYuan(rational(18 * 1120000, 18)), "¥11200.00");
  assert.equal(formatYuan(rational(1120000, 1)), "¥11200.00");
});

test("Shanghai clock maps the two reminder instants", () => {
  const morning = shanghaiNow(new Date("2026-10-28T00:05:00.000Z"));
  const evening = shanghaiNow(new Date("2026-10-28T10:05:00.000Z"));
  assert.deepEqual(morning, { date: "2026-10-28", minutesOfDay: 8 * 60 + 5 });
  assert.deepEqual(evening, { date: "2026-10-28", minutesOfDay: 18 * 60 + 5 });
});

test("statutory holidays, weekends and makeup days", async () => {
  const { calendar } = await fixtures();
  assert.equal(classifyDate("2026-10-01", calendar).kind, "holiday");
  assert.equal(classifyDate("2026-10-07", calendar).kind, "holiday");
  assert.equal(classifyDate("2026-10-10", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-10-10", calendar).work, true);
  assert.equal(classifyDate("2026-10-11", calendar).kind, "weekend");
  assert.equal(classifyDate("2026-10-17", calendar).kind, "weekend");
  assert.equal(classifyDate("2026-10-28", calendar).kind, "weekday");
  assert.equal(classifyDate("2026-02-14", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-02-16", calendar).kind, "holiday");
  assert.equal(classifyDate("2026-02-28", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-01-04", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-05-01", calendar).kind, "holiday");
  assert.equal(classifyDate("2026-05-09", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-09-20", calendar).kind, "makeup");
  assert.equal(classifyDate("2026-09-25", calendar).kind, "holiday");
  assert.equal(classifyDate("2025-01-01", calendar).kind, "holiday");
  assert.equal(classifyDate("2025-01-26", calendar).kind, "makeup");
  assert.equal(classifyDate("2024-10-01", calendar).work, false);
  const overridden = loadCalendar(await loadHolidayDirectory(holidayDir), [
    { date: "2026-10-28", name: "临时放假", isOffDay: true },
  ]);
  assert.equal(classifyDate("2026-10-28", overridden).kind, "holiday");
  assert.throws(() => classifyDate("2027-01-04", calendar), /2027/);
});

test("every 2026 month sums exactly to the configured salary", async () => {
  const { calendar } = await fixtures();
  for (let month = 1; month <= 12; month += 1) {
    const plan = planFor(calendar, 2026, month);
    assert.ok(plan.workdays.length > 0);
    assert.ok(ratEq(sumBase(plan), rational(MONTH_CENTS, 1)), `2026-${month}`);
    assert.ok(ratEq(plan.workdays[0].cents, plan.workdays.at(-1).cents));
    const october = month === 10 ? plan : null;
    if (october) {
      assert.deepEqual(october.workdays.map((day) => day.date), [
        "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-12", "2026-10-13", "2026-10-14",
        "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22",
        "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30",
      ]);
    }
  }
  const february = planFor(calendar, 2026, 2);
  assert.equal(february.workdays.some((day) => day.date === "2026-02-14"), true);
  assert.equal(february.workdays.some((day) => day.date === "2026-02-16"), false);
  assert.equal(february.workdays.some((day) => day.date === "2026-02-28"), true);
});

test("paid leave keeps the month total and unpaid leave removes that day's original share", async () => {
  const { calendar } = await fixtures();
  const original = planFor(calendar, 2026, 10);
  const share = original.originalByDate.get("2026-10-28");
  assert.ok(ratEq(share, rational(MONTH_CENTS, 18)));
  const paid = planFor(calendar, 2026, 10, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }]));
  assert.equal(isSalaryWorkday("2026-10-28", calendar, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }])), false);
  assert.ok(ratEq(sumBase(paid), rational(MONTH_CENTS, 1)));
  assert.equal(paid.workdays.some((day) => day.date === "2026-10-28"), false);
  assert.equal(ratCmp(paid.workdays[0].cents, original.workdays[0].cents), 1);

  const unpaidAdj = indexAdjustments([{ date: "2026-10-28", kind: "unpaid_leave" }]);
  const unpaid = planFor(calendar, 2026, 10, unpaidAdj);
  assert.ok(ratEq(sumBase(unpaid), ratSub(rational(MONTH_CENTS, 1), share)));

  const deducted = planFor(calendar, 2026, 10, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }]), {
    monthlyNetCents: MONTH_CENTS,
    paidLeaveKeepsSalary: false,
  });
  assert.ok(ratEq(sumBase(deducted), ratSub(rational(MONTH_CENTS, 1), share)));
});

test("manual rest, makeup work and explicit overtime", async () => {
  const { calendar } = await fixtures();
  const adjustments = indexAdjustments([
    { date: "2026-10-29", kind: "rest" },
    { date: "2026-10-11", kind: "work" },
    { date: "2026-10-13", kind: "overtime", cents: 880 },
    { date: "2026-10-15", kind: "overtime" },
  ]);
  const plan = planFor(calendar, 2026, 10, adjustments);
  assert.equal(plan.workdays.some((day) => day.date === "2026-10-29"), false);
  assert.equal(plan.workdays.some((day) => day.date === "2026-10-11"), true);
  assert.ok(ratEq(sumBase(plan), rational(MONTH_CENTS, 1)));
  const thirteenth = plan.workdays.find((day) => day.date === "2026-10-13");
  assert.equal(thirteenth.overtimeCents, 880);
  assert.ok(ratEq(sumWithOvertime(plan), rational(MONTH_CENTS + 880, 1)));
  assert.equal(plan.workdays.find((day) => day.date === "2026-10-15").overtimeCents, 0);
  assert.equal(plan.offDayOvertime.length, 0);
  const weekendOvertime = planFor(calendar, 2026, 10, indexAdjustments([
    { date: "2026-10-17", kind: "overtime", cents: 500 },
  ]));
  assert.equal(weekendOvertime.workdays.some((day) => day.date === "2026-10-17"), false);
  assert.equal(weekendOvertime.offDayOvertime[0].overtimeCents, 500);
  assert.throws(() => indexAdjustments([{ date: "2026-10-13", kind: "overtime", cents: 1.5 }]), /整数分/);
});

test("month boundaries keep their own totals", async () => {
  const { calendar, adjustments } = await fixtures();
  const october = planFor(calendar, 2026, 10, adjustments);
  const november = planFor(calendar, 2026, 11, adjustments);
  assert.ok(ratEq(sumBase(october), rational(MONTH_CENTS, 1)));
  assert.ok(ratEq(sumBase(november), rational(MONTH_CENTS, 1)));
  const firstNovember = november.workdays[0].date;
  const octoberEnd = totalsThrough(october, "2026-10-30");
  assert.ok(ratEq(ratAdd(octoberEnd.before, octoberEnd.today), rational(MONTH_CENTS, 1)));
  assert.equal(formatYuan(ratAdd(octoberEnd.before, octoberEnd.today)), "¥11200.00");
  assert.ok(ratEq(totalsThrough(november, firstNovember).before, rational(0, 1)));
  assert.notEqual(firstNovember.slice(0, 7), "2026-10");
});

test("messages follow the workday, the clock and special days", async () => {
  const { calendar, library, adjustments } = await fixtures();
  const october = planFor(calendar, 2026, 10, adjustments);
  const morningNow = { date: "2026-10-28", minutesOfDay: 8 * 60 + 5 };
  const morning = buildReminder({
    slot: "morning",
    now: morningNow,
    plan: october,
    calendar,
    adjustments,
    lines: library.morning,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  const figures = totalsThrough(october, "2026-10-28");
  const morningCopy = library.morning.find((line) => line.id === morning.copyId);
  assert.equal(morning.title, "今日待赚 ¥622.22");
  assert.equal(morning.title.includes("\n"), false);
  assert.equal(morning.title.includes("|"), false);
  assert.equal(morning.title.includes("｜"), false);
  assert.equal(morning.title.includes("测试"), false);
  assert.equal(morning.title.includes("打工自由助手"), false);
  assert.equal(morning.title.includes("周三了"), false);
  assert.equal(morning.title.includes("还有1008天"), false);
  assert.equal(morning.title.includes(morningCopy.text), false);
  assert.equal(morning.content.includes("今日待赚 ¥622.22"), false);
  assert.match(morning.content, /本月累计 ¥9333\.33/);
  assert.equal(morning.content.includes("¥9955.56"), false);
  assert.match(morning.content, /距离下班：9小时55分钟/);
  assert.match(morning.content, /距离上班十周年：还有1008天/);
  assert.match(morning.content, /已工作：7年2个月27天/);
  assert.match(morning.content, /这周已经过半|这周过半/);
  assert.match(morning.content, /不是银行卡到账/);
  assert.equal(morning.content.split(morningCopy.text).length - 1, 1);
  assert.equal(morning.content.includes("周五了。做完今天"), false);
  assert.equal(morning.content.includes("打工自由助手"), false);
  assert.equal(morningCopy.tags.includes("wednesday"), true);
  assert.equal(formatYuan(figures.today), "¥622.22");
  assert.equal(formatYuan(figures.before), "¥9333.33");

  const late = buildReminder({
    slot: "morning",
    now: { date: "2026-10-28", minutesOfDay: 18 * 60 + 30 },
    plan: october,
    calendar,
    adjustments,
    lines: library.morning,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  assert.match(late.content, /已经到下班时间/);

  const evening = buildReminder({
    slot: "evening",
    now: { date: "2026-10-28", minutesOfDay: 18 * 60 + 5 },
    plan: october,
    calendar,
    adjustments,
    lines: library.evening,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  const eveningCopy = library.evening.find((line) => line.id === evening.copyId);
  assert.equal(evening.title, "下班啦 +¥622.22");
  assert.equal(evening.title.includes("测试"), false);
  assert.equal(evening.title.includes("打工自由助手"), false);
  assert.equal(evening.title.includes("周三了"), false);
  assert.equal(evening.title.includes("还有1008天"), false);
  assert.equal(evening.title.includes("｜"), false);
  assert.equal(evening.title.includes(eveningCopy.text), false);
  assert.equal(evening.content.includes("下班啦 +¥622.22"), false);
  assert.equal(evening.content.includes("下班到账"), false);
  assert.match(evening.content, /本月累计 ¥9955\.56/);
  assert.equal(evening.content.includes("¥9333.33"), false);
  assert.match(evening.content, /本月剩余工作日：2天/);
  assert.match(evening.content, /距离上班十周年：还有1008天/);
  assert.equal(evening.content.split(eveningCopy.text).length - 1, 1);
  assert.equal(formatYuan(ratAdd(figures.before, figures.today)), "¥9955.56");

  const monday = buildReminder({
    slot: "morning", now: { date: "2026-10-12", minutesOfDay: 8 * 60 }, plan: october, calendar, adjustments,
    lines: library.morning, recent: [], workEndMinutes: 18 * 60,
  });
  assert.match(monday.content, /周一/);
  const friday = buildReminder({
    slot: "evening", now: { date: "2026-10-16", minutesOfDay: 18 * 60 }, plan: october, calendar, adjustments,
    lines: library.evening, recent: [], workEndMinutes: 18 * 60,
  });
  assert.match(friday.content, /周末/);
  const makeupFriday = buildReminder({
    slot: "morning", now: { date: "2026-10-09", minutesOfDay: 8 * 60 }, plan: october, calendar, adjustments,
    lines: library.morning, recent: [], workEndMinutes: 18 * 60,
  });
  assert.equal(makeupFriday.content.includes("周五了。做完今天，周末把时间还给自己。"), false);

  const september = planFor(calendar, 2026, 9, adjustments);
  assert.equal(isPreHoliday("2026-09-24", calendar, adjustments), true);
  const beforeHoliday = buildReminder({
    slot: "morning", now: { date: "2026-09-24", minutesOfDay: 8 * 60 }, plan: september, calendar, adjustments,
    lines: library.morning, recent: [], workEndMinutes: 18 * 60,
  });
  assert.match(beforeHoliday.content, /假期/);

  const monthEnd = buildReminder({
    slot: "evening", now: { date: "2026-10-30", minutesOfDay: 18 * 60 }, plan: october, calendar, adjustments,
    lines: library.evening, recent: [], workEndMinutes: 18 * 60,
  });
  assert.match(monthEnd.content, /本月最后一个工作日|一个月的班上完了|月末/);
  assert.match(monthEnd.content, /本月剩余工作日：0天/);
  assert.match(monthEnd.content, /本月累计 ¥11200\.00/);
  assert.equal(monthEnd.title, "下班啦 +¥622.22");
  assert.equal(library.evening.find((line) => line.id === monthEnd.copyId).tags.includes("month_end"), true);
  const monthEndMorning = buildReminder({
    slot: "morning", now: { date: "2026-10-30", minutesOfDay: 8 * 60 }, plan: october, calendar, adjustments,
    lines: library.morning, recent: [], workEndMinutes: 18 * 60,
  });
  assert.match(monthEndMorning.content, /本月累计 ¥10577\.78/);
  assert.equal(monthEndMorning.title, "今日待赚 ¥622.22");
});

test("copy libraries stay large, gentle, and unique across 14 workdays", async () => {
  const { calendar, library, adjustments } = await fixtures();
  const banned = ["努力奋斗", "为单位奉献", "燃烧自己", "拼搏到底", "工作是人生的意义", "奋斗", "拼搏", "奉献", "内卷", "狼性", "996", "加班"];
  const blob = JSON.stringify(library) + JSON.stringify(CONTEXT_LINES) + JSON.stringify(ANNIVERSARY_DAY);
  for (const phrase of banned) assert.equal(blob.includes(phrase), false, phrase);
  assert.ok(library.morning.length >= 50);
  assert.ok(library.evening.length >= 50);
  assert.ok(library.morning.length + library.evening.length >= 100);
  const anniversaryCopy = library.morning.filter((line) => line.tags.includes("anniversary"));
  assert.ok(anniversaryCopy.length >= 4);
  assert.ok(anniversaryCopy.length < library.morning.length / 2);
  for (const slot of ["morning", "evening"]) {
    let recent = [];
    const ids = [];
    let anniversaryHits = 0;
    for (let month = 10; month <= 11; month += 1) {
      const plan = planFor(calendar, 2026, month, adjustments);
      for (const day of plan.workdays) {
        const contexts = reminderContexts({ date: day.date, slot, calendar, adjustments, plan });
        const line = selectCopy(library[slot], { date: day.date, slot, contexts, recent });
        ids.push(line.id);
        if (line.tags.includes("anniversary")) anniversaryHits += 1;
        recent = rememberCopy(recent, { date: day.date, slot, id: line.id });
        const again = selectCopy(library[slot], { date: day.date, slot, contexts, recent });
        assert.equal(again.id, line.id);
      }
    }
    assert.ok(ids.length >= 14);
    for (let index = 0; index + 14 <= ids.length; index += 1) {
      assert.equal(new Set(ids.slice(index, index + 14)).size, 14);
    }
    assert.ok(anniversaryHits > 0);
    assert.ok(anniversaryHits < ids.length / 2);
  }
  assert.equal(hashText("2026-10-28:morning"), hashText("2026-10-28:morning"));
});

test("tenth-anniversary countdown uses calendar days and never goes negative", async () => {
  const { calendar, library, adjustments } = await fixtures();
  const crowded = buildNotificationTitle({
    slot: "morning",
    todayAmount: rational(MONTH_CENTS, 1),
    comfort: "照常做完就好不必把今天过成一场考核也不必向任何人证明",
  });
  assert.equal(crowded, "今日待赚 ¥11200.00");
  assert.equal(crowded.includes("3653"), false);
  assert.equal(crowded.includes("十周年"), false);
  assert.equal(crowded.includes("\n"), false);
  assert.equal(crowded.includes("｜"), false);
  assert.equal(crowded.includes("照常做完"), false);
  assert.equal(calendarDaysBetween("2019-08-01", "2029-08-01"), 3653);
  assert.equal(calendarDaysBetween("2026-10-28", "2029-08-01"), 1008);
  assert.equal(calendarDaysBetween("2026-09-30", "2026-10-08"), 8);
  assert.equal(calendarDaysBetween("2026-10-30", "2026-11-02"), 3);
  const beforeHoliday = describeAnniversary("2026-09-30");
  const afterHoliday = describeAnniversary("2026-10-08");
  assert.equal(beforeHoliday.daysLeft - afterHoliday.daysLeft, 8);
  const friday = describeAnniversary("2026-10-30");
  const monday = describeAnniversary("2026-11-02");
  assert.equal(friday.daysLeft - monday.daysLeft, 3);
  assert.equal(countdownLine(describeAnniversary("2026-10-28")), "距离上班十周年：还有1008天");
  assert.deepEqual(calendarElapsed("2019-08-01", "2019-08-01"), { years: 0, months: 0, days: 0 });
  assert.deepEqual(calendarElapsed("2019-08-01", "2019-08-31"), { years: 0, months: 0, days: 30 });
  assert.deepEqual(calendarElapsed("2019-08-01", "2019-09-01"), { years: 0, months: 1, days: 0 });
  assert.deepEqual(calendarElapsed("2019-08-01", "2020-08-01"), { years: 1, months: 0, days: 0 });
  assert.deepEqual(calendarElapsed("2019-08-01", "2020-02-29"), { years: 0, months: 6, days: 28 });
  assert.deepEqual(calendarElapsed("2019-08-01", "2026-10-28"), { years: 7, months: 2, days: 27 });
  assert.equal(formatElapsed(calendarElapsed("2019-08-01", "2026-10-28")), "7年2个月27天");
  assert.deepEqual(calendarElapsed("2024-01-31", "2024-03-01"), { years: 0, months: 1, days: 1 });

  const october = planFor(calendar, 2026, 10, adjustments);
  const morning = buildReminder({
    slot: "morning",
    now: { date: "2026-10-28", minutesOfDay: 8 * 60 + 5 },
    plan: october,
    calendar,
    adjustments,
    lines: library.morning,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  assert.match(morning.content, /距离上班十周年：还有1008天/);
  assert.match(morning.content, /已工作：7年2个月27天/);
  assert.ok(ratEq(sumBase(october), rational(MONTH_CENTS, 1)));

  const today = describeAnniversary("2029-08-01");
  assert.equal(today.phase, "today");
  assert.equal(countdownLine(today), "上班十周年：今天");
  assert.equal(formatElapsed(today.elapsed), "10年0个月0天");
  const anniversaryMorning = buildReminder({
    slot: "morning",
    now: { date: "2029-08-01", minutesOfDay: 8 * 60 },
    plan: october,
    calendar,
    adjustments,
    lines: library.morning,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  assert.equal(anniversaryMorning.title, "上班十周年");
  assert.equal(anniversaryMorning.title.includes("十周年今天"), false);
  assert.equal(anniversaryMorning.title.includes("测试"), false);
  assert.equal(anniversaryMorning.title.includes("打工自由助手"), false);
  assert.equal(anniversaryMorning.title.includes("还有"), false);
  assert.equal(anniversaryMorning.title.includes("｜"), false);
  assert.notEqual(anniversaryMorning.title, ANNIVERSARY_DAY.morning[0]);
  assert.equal(anniversaryMorning.content.split(ANNIVERSARY_DAY.morning[0]).length - 1, 1);
  assert.match(anniversaryMorning.content, /上班十周年：今天/);
  assert.match(anniversaryMorning.content, /已工作：10年0个月0天/);
  assert.match(anniversaryMorning.content, /不是辞职日/);
  assert.match(anniversaryMorning.content, /重新选择生活的权利/);
  assert.equal(anniversaryMorning.content.includes("还有-"), false);
  assert.equal(anniversaryMorning.copyId, null);
  const anniversaryEvening = buildReminder({
    slot: "evening",
    now: { date: "2029-08-01", minutesOfDay: 18 * 60 },
    plan: october,
    calendar,
    adjustments,
    lines: library.evening,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  assert.match(anniversaryEvening.content, /不是辞职日/);
  assert.match(anniversaryEvening.content, /不是离职通知/);

  const after = describeAnniversary("2029-08-02");
  assert.equal(after.phase, "after");
  assert.equal(after.daysLeft, null);
  assert.equal(countdownLine(after), "上班十周年已达成");
  assert.equal(formatElapsed(after.elapsed), "10年0个月1天");
  assert.equal(countdownLine(after).includes("-"), false);
  const year2029 = loadCalendar([{
    year: 2029,
    days: [{ date: "2029-01-01", name: "元旦", isOffDay: true }],
  }]);
  const august = planFor(year2029, 2029, 8, adjustments);
  const later = buildReminder({
    slot: "evening",
    now: { date: "2029-08-02", minutesOfDay: 18 * 60 },
    plan: august,
    calendar: year2029,
    adjustments,
    lines: library.evening,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  assert.match(later.content, /上班十周年已达成/);
  assert.match(later.content, /已工作：10年0个月1天/);
  assert.equal(later.content.includes("还有-"), false);
  assert.equal(/-\d+天/.test(later.content), false);
});

test("the anniversary day still sends when that year's holiday file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-anniversary-"));
  let content = "";
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.day.app/push");
    content = JSON.parse(init.body).body;
    return jsonResponse({ code: 200, message: "success", timestamp: 1 });
  };
  const logger = createLogger([DEVICE_KEY], { log() {}, error() {} });
  const options = {
    now: new Date("2029-08-01T00:05:00.000Z"),
    event: "schedule",
    schedule: "5 0 * * *",
    deviceKey: DEVICE_KEY,
    statePath: join(dir, "state.json"),
    fetchImpl,
    sleep: async () => {},
    logger,
    pollAttempts: 1,
    pollIntervalMs: 0,
  };
  const sent = await run(options);
  assert.equal(sent.action, "sent");
  assert.equal(sent.date, "2029-08-01");
  assert.match(content, /上班十周年：今天/);
  assert.match(content, /已工作：10年0个月0天/);
  assert.match(content, /不是辞职日/);
  assert.match(content, /重新选择/);
  assert.equal(content.includes("还有-"), false);
  assert.equal(content.includes("今日待赚"), false);
  assert.equal(content.includes("元"), false);
  const again = await run(options);
  assert.equal(again.reason, "duplicate");
  await assert.rejects(() => run({ ...options, now: new Date("2029-08-02T00:05:00.000Z") }), /法定节假日数据/);
  await rm(dir, { recursive: true, force: true });
});

test("Bark payload is a JSON post and logs omit the device key and salary", async () => {
  const logs = [];
  const calls = [];
  const logger = createLogger([DEVICE_KEY], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      href: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    });
    return jsonResponse({ code: 200, message: "success", timestamp: 1700000000 });
  };
  const title = "今日待赚 ¥622.22";
  const notice = "本月累计 ¥9333.33\n距离上班十周年：还有1008天\n做完即可。";
  const result = await deliverMessage({
    fetchImpl,
    sleep: async () => {},
    deviceKey: DEVICE_KEY,
    title,
    body: notice,
    logger,
  });
  assert.equal(result.code, 200);
  assert.equal(result.resent, false);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.href, "https://api.day.app/push");
  assert.equal(sent.href.includes(DEVICE_KEY), false);
  assert.equal(sent.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(Object.keys(sent.body).sort(), ["body", "device_key", "group", "level", "sound", "title"]);
  assert.equal(sent.body.device_key === DEVICE_KEY, true);
  assert.equal(sent.body.title, title);
  assert.equal(sent.body.body, notice);
  assert.equal(sent.body.group, "打工自由助手");
  assert.equal(sent.body.level, "active");
  assert.equal(sent.body.sound, "bell");
  assert.equal("call" in sent.body, false);
  assert.equal(Object.hasOwn(sent.body, "url"), false);
  assertNoSecret(JSON.stringify({ ...sent.body, device_key: "" }));
  assertNoSecret(sent.href);
  const logged = logs.join("\n");
  assertNoSecret(logged);
  assert.equal(logged.includes("622.22"), false);
  assert.equal(logged.includes("11200"), false);
  assert.equal(logged.includes("9333.33"), false);
  assert.match(logged, /code=200/);
  const redacted = safeReason(`balance 880 key ${DEVICE_KEY}`, logger.redact);
  assertNoSecret(redacted);
  assert.match(redacted, /balance # key \[redacted\]/);
});

test("Bark accepts only HTTP 200 with JSON code 200, and retries transient failures", async () => {
  const logs = [];
  const logger = createLogger([DEVICE_KEY], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  const notice = { deviceKey: DEVICE_KEY, title: "今日待赚 ¥622.22", body: "本月累计 ¥9333.33", logger };
  let rejected = 0;
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => {
      rejected += 1;
      return jsonResponse({ code: 400, message: `bad device ${DEVICE_KEY}`, timestamp: 1 }, 400);
    },
    sleep: async () => {},
    ...notice,
    maxAttempts: 3,
  }), /拒绝/);
  assert.equal(rejected, 1);
  assertNoSecret(logs.join("\n"));
  assert.equal(logs.join("\n").includes("622.22"), false);
  assert.equal(logs.join("\n").includes("9333.33"), false);

  let zeroCode = 0;
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => {
      zeroCode += 1;
      return jsonResponse({ code: 0, message: "success", timestamp: 1 }, 200);
    },
    sleep: async () => {},
    ...notice,
  }), /拒绝/);
  assert.equal(zeroCode, 1);

  const delays = [];
  let attempt = 0;
  const recovered = await deliverMessage({
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`network ${DEVICE_KEY}`);
      if (attempt === 2) return jsonResponse({ code: 500, message: "push failed", timestamp: 1 }, 500);
      return jsonResponse({ code: 200, message: "success", timestamp: 1 });
    },
    sleep: async (ms) => { delays.push(ms); },
    ...notice,
  });
  assert.equal(recovered.code, 200);
  assert.equal(recovered.resent, true);
  assert.equal(attempt, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assertNoSecret(logs.join("\n"));

  let exhausted = 0;
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => {
      exhausted += 1;
      return jsonResponse({ code: 200, message: "success", timestamp: 1 }, 503);
    },
    sleep: async () => {},
    ...notice,
  }), /Bark 请求失败/);
  assert.equal(exhausted, 3);

  let called = 0;
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => {
      called += 1;
      return jsonResponse({ code: 200, message: "success", timestamp: 1 });
    },
    sleep: async () => {},
    deviceKey: "",
    title: "今日待赚 ¥622.22",
    body: "正文",
    logger,
  }), /缺少 BARK_DEVICE_KEY/);
  assert.equal(called, 0);
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => jsonResponse({ code: 200, message: "success", timestamp: 1 }),
    sleep: async () => {},
    deviceKey: "https://api.day.app/secret",
    title: "今日待赚 ¥622.22",
    body: "正文",
    logger,
  }), /无效/);
});

test("a workday send is recorded once and skipped the second time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const logs = [];
  const logger = createLogger([DEVICE_KEY], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  let sends = 0;
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.day.app/push");
    assert.equal(String(url).includes(DEVICE_KEY), false);
    sends += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.device_key === DEVICE_KEY, true);
    assert.equal(body.group, "打工自由助手");
    assert.equal(body.level, "active");
    assert.equal(body.sound, "bell");
    if (sends === 1) assert.equal(body.title, "今日待赚 ¥622.22");
    return jsonResponse({ code: 200, message: "success", timestamp: 1 });
  };
  const options = {
    now: new Date("2026-10-28T00:05:00.000Z"),
    event: "schedule",
    schedule: "5 0 * * *",
    deviceKey: DEVICE_KEY,
    statePath: join(dir, "state.json"),
    fetchImpl,
    sleep: async () => {},
    logger,
    pollAttempts: 1,
    pollIntervalMs: 0,
  };
  const first = await run(options);
  assert.equal(first.action, "sent");
  assert.equal(first.slot, "morning");
  const state = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.equal(state.sent["2026-10-28"].morning.status, "sent");
  assertNoSecret(JSON.stringify(state));
  assert.equal(JSON.stringify(state).includes("11200"), false);
  let eveningTitle = "";
  const evening = await run({
    ...options,
    now: new Date("2026-10-28T10:05:00.000Z"),
    schedule: "5 10 * * *",
    fetchImpl: async (url, init = {}) => {
      sends += 1;
      assert.equal(String(url), "https://api.day.app/push");
      const body = JSON.parse(init.body);
      eveningTitle = body.title;
      assert.equal(body.group, "打工自由助手");
      assert.equal(body.level, "active");
      assert.equal(body.sound, "bell");
      assert.equal("call" in body, false);
      assert.match(body.body, /本月累计 ¥9955\.56/);
      assert.match(body.body, /距离上班十周年：还有1008天/);
      assert.equal(body.body.includes(eveningTitle), false);
      assertNoSecret(body.body);
      return jsonResponse({ code: 200, message: "success", timestamp: 1 });
    },
  });
  assert.equal(evening.action, "sent");
  assert.equal(evening.slot, "evening");
  assert.equal(eveningTitle, "下班啦 +¥622.22");
  const second = await run(options);
  assert.equal(second.reason, "duplicate");
  assert.equal(sends, 2);
  const weekend = await run({ ...options, now: new Date("2026-10-31T00:05:00.000Z") });
  assert.equal(weekend.reason, "not-workday");
  const holiday = await run({ ...options, now: new Date("2026-09-30T16:05:00.000Z") });
  assert.equal(holiday.date, "2026-10-01");
  assert.equal(holiday.reason, "not-workday");
  const makeup = await run({ ...options, now: new Date("2026-10-10T00:05:00.000Z"), schedule: "5 0 * * *" });
  assert.equal(makeup.action, "sent");
  assert.equal(sends, 3);
  assertNoSecret(logs.join("\n"));
  assert.equal(logs.join("\n").includes("元"), false);
  await rm(dir, { recursive: true, force: true });
});

test("a rejected Bark response does not mark the slot sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const statePath = join(dir, "state.json");
  let sends = 0;
  const fetchImpl = async () => {
    sends += 1;
    return jsonResponse({ code: 400, message: "failed to get device token", timestamp: 1 }, 400);
  };
  const logger = createLogger([DEVICE_KEY], { log() {}, error() {} });
  const options = {
    now: new Date("2026-10-28T10:05:00.000Z"),
    event: "schedule",
    schedule: "5 10 * * *",
    deviceKey: DEVICE_KEY,
    statePath,
    fetchImpl,
    sleep: async () => {},
    logger,
    maxAttempts: 3,
  };
  await assert.rejects(() => run(options), /拒绝/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.sent["2026-10-28"], undefined);
  assert.equal(sends, 1);
  assertNoSecret(JSON.stringify(state));
  await rm(dir, { recursive: true, force: true });
});

test("flags, test sends and slot parsing stay isolated from the salary ledger", async () => {
  assert.equal(resolveSlot({ event: "schedule", schedule: "5 0 * * *" }), "morning");
  assert.equal(resolveSlot({ event: "schedule", schedule: "5 10 * * *" }), "evening");
  assert.equal(resolveSlot({ event: "workflow_dispatch", slot: "test" }), "test");

  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const custom = JSON.parse(await readFile(configPath, "utf8"));
  custom.morningEnabled = false;
  const customPath = join(dir, "config.json");
  await writeFile(customPath, JSON.stringify(custom));
  const skipped = await run({
    now: new Date("2026-10-28T00:05:00.000Z"),
    event: "workflow_dispatch",
    slot: "morning",
    configPath: customPath,
    statePath: join(dir, "state.json"),
    dryRun: true,
    logger: createLogger([], { log() {}, error() {} }),
  });
  assert.equal(skipped.reason, "disabled");

  let sends = 0;
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.day.app/push");
    sends += 1;
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["body", "device_key", "group", "level", "sound", "title"]);
    assert.equal(body.title, "确认推送通道");
    assert.equal(body.title.includes("测试"), false);
    assert.equal(body.level, "active");
    assert.equal(body.sound, "bell");
    assert.equal(body.group, "打工自由助手");
    assert.match(body.body, /【测试】/);
    assert.equal(body.body.includes("今日待赚"), false);
    assertNoSecret(body.body);
    assertNoSecret(String(url));
    return jsonResponse({ code: 200, message: "success", timestamp: 1 });
  };
  const testRun = await run({
    now: new Date("2026-10-31T02:00:00.000Z"),
    event: "workflow_dispatch",
    slot: "test",
    deviceKey: DEVICE_KEY,
    statePath: join(dir, "state.json"),
    fetchImpl,
    sleep: async () => {},
    logger: createLogger([DEVICE_KEY], { log() {}, error() {} }),
    pollAttempts: 1,
  });
  assert.equal(testRun.action, "sent");
  assert.equal(sends, 1);
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(state.sent["2026-10-31"], undefined);

  const names = [];
  async function walk(dirName) {
    for (const entry of await readdir(dirName, { withFileTypes: true })) {
      const path = join(dirName, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".mjs")) names.push(path);
    }
  }
  await walk(join(root, "wage-remind"));
  const source = (await Promise.all(names.map((path) => readFile(path, "utf8")))).join("\n");
  assert.equal(source.includes("app.js"), false);
  assert.equal(source.includes("market-data.js"), false);
  assert.equal(source.includes("data/market.json"), false);
  assert.equal(source.includes("tangping-dividend"), false);
  const workflow = await readFile(join(root, ".github/workflows/wage-remind.yml"), "utf8");
  assert.equal(workflow.includes("git commit"), false);
  assert.equal(workflow.includes("data/market.json"), false);
  const watched = [
    source,
    workflow,
    await readFile(join(root, "wage-remind/README.md"), "utf8"),
    await readFile(join(root, "README.md"), "utf8"),
  ].join("\n");
  assert.equal(/serverchan|SERVERCHAN|Server酱|方糖|sctapi|ftqq|SENDKEY|SendKey/i.test(watched), false);
  assert.match(workflow, /BARK_DEVICE_KEY/);
  assert.equal(workflow.includes("SERVERCHAN_SENDKEY"), false);
  const market = await readFile(join(root, ".github/workflows/update-market-data.yml"), "utf8");
  assert.equal(market.includes("wage-remind"), false);
  await rm(dir, { recursive: true, force: true });
});

test("dry run prints no salary and no token", () => {
  const dir = spawnSync("mktemp", ["-d"]);
  const statePath = `${String(dir.stdout).trim()}/state.json`;
  const result = spawnSync(process.execPath, ["wage-remind/cli.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      WAGE_DRY_RUN: "1",
      WAGE_EVENT: "workflow_dispatch",
      WAGE_SLOT: "morning",
      WAGE_NOW: "2026-10-28T00:05:00.000Z",
      WAGE_STATE_PATH: statePath,
      BARK_DEVICE_KEY: DEVICE_KEY,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /action=dry-run/);
  assertNoSecret(output);
  assert.equal(output.includes("元"), false);
  assert.equal(output.includes("¥"), false);
  assert.equal(output.includes("11200"), false);
  assert.equal(output.includes("622.22"), false);
});

test("comfort stays in the body while titles stay amount-only and the default salary is 11200", async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.monthlyNetYuan, 11200);
  const { calendar, library, adjustments } = await fixtures();
  const october = planFor(calendar, 2026, 10, adjustments);
  const copyIds = new Set();
  for (const day of october.workdays) {
    const message = buildReminder({
      slot: "morning",
      now: { date: day.date, minutesOfDay: 8 * 60 },
      plan: october,
      calendar,
      adjustments,
      lines: library.morning,
      recent: [],
      workEndMinutes: 18 * 60,
    });
    assert.equal(message.title, "今日待赚 ¥622.22");
    assert.equal(/测试|打工自由助手|周[一二三四五六日]了|morning|evening|\||｜/.test(message.title), false);
    const copy = library.morning.find((line) => line.id === message.copyId).text;
    assert.equal(message.title.includes(copy), false);
    assert.equal(message.content.split(copy).length - 1, 1);
    assert.match(message.content, /本月累计 /);
    assert.match(message.content, /距离上班十周年/);
    copyIds.add(message.copyId);
  }
  assert.ok(copyIds.size > 2);
  const bundled = [
    JSON.stringify(config),
    await readFile(join(root, "wage-remind/README.md"), "utf8"),
    await readFile(join(root, "wage-remind/lib/message.mjs"), "utf8"),
    await readFile(join(root, "wage-remind/lib/wage.mjs"), "utf8"),
    await readFile(join(root, "wage-remind/lib/money.mjs"), "utf8"),
  ].join("\n");
  assert.equal(/(^|[^0-9])1120([^0-9]|$)/.test(bundled), false);
});

test("a manual test on a workday keeps the wage title and marks only the body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const { calendar, library, adjustments } = await fixtures();
  const october = planFor(calendar, 2026, 10, adjustments);
  const preview = buildReminder({
    slot: "morning",
    now: { date: "2026-10-28", minutesOfDay: 8 * 60 + 5 },
    plan: october,
    calendar,
    adjustments,
    lines: library.morning,
    recent: [],
    workEndMinutes: 18 * 60,
  });
  let body;
  const fetchImpl = async (url, init = {}) => {
    assert.equal(String(url), "https://api.day.app/push");
    body = JSON.parse(init.body);
    return jsonResponse({ code: 200, message: "success", timestamp: 1 });
  };
  const sent = await run({
    now: new Date("2026-10-28T00:05:00.000Z"),
    event: "workflow_dispatch",
    slot: "test",
    deviceKey: DEVICE_KEY,
    statePath: join(dir, "state.json"),
    fetchImpl,
    sleep: async () => {},
    logger: createLogger([DEVICE_KEY], { log() {}, error() {} }),
    pollAttempts: 1,
  });
  assert.equal(sent.action, "sent");
  assert.equal(body.title, preview.title);
  assert.equal(body.title, "今日待赚 ¥622.22");
  assert.equal(body.title.includes("测试"), false);
  assert.equal(body.group, "打工自由助手");
  assert.equal(body.level, "active");
  assert.equal(body.sound, "bell");
  assert.equal(body.device_key === DEVICE_KEY, true);
  assertNoSecret(String(body.body));
  assert.match(body.body, /【测试】/);
  assert.match(body.body, /本月累计 ¥9333\.33/);
  assert.match(body.body, /距离上班十周年：还有1008天/);
  const copy = library.morning.find((line) => line.id === preview.copyId).text;
  assert.equal(body.body.split(copy).length - 1, 1);
  assert.equal(body.title.includes(copy), false);
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(state.sent["2026-10-28"], undefined);
  await rm(dir, { recursive: true, force: true });
});
