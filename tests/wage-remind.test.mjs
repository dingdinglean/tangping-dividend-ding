import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarDaysBetween, calendarElapsed, countdownLine, describeAnniversary, formatElapsed } from "../wage-remind/lib/anniversary.mjs";
import { loadCalendar, loadHolidayDirectory, classifyDate } from "../wage-remind/lib/calendar.mjs";
import { hashText, loadCopyLibrary, selectCopy } from "../wage-remind/lib/copy.mjs";
import { ANNIVERSARY_DAY, CONTEXT_LINES, TITLE_LIMIT, buildNotificationTitle, buildReminder, isPreHoliday, reminderContexts } from "../wage-remind/lib/message.mjs";
import { allocateCents, formatYuan, yuanToCents } from "../wage-remind/lib/money.mjs";
import { createLogger, deliverMessage, safeReason } from "../wage-remind/lib/serverchan.mjs";
import { resolveSlot, run } from "../wage-remind/lib/run.mjs";
import { rememberCopy } from "../wage-remind/lib/state.mjs";
import { shanghaiNow } from "../wage-remind/lib/time.mjs";
import { buildMonthPlan, indexAdjustments, isSalaryWorkday, totalsThrough } from "../wage-remind/lib/wage.mjs";

const root = new URL("..", import.meta.url).pathname;
const holidayDir = join(root, "wage-remind/data/holidays");
const copyPath = join(root, "wage-remind/data/copy.json");
const configPath = join(root, "wage-remind/config.json");

const baseConfig = {
  monthlyNetCents: yuanToCents(1120),
  paidLeaveKeepsSalary: true,
};

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

test("money uses integer cents and the last day absorbs the remainder", () => {
  assert.equal(yuanToCents(1120), 112000);
  assert.equal(yuanToCents("1120.5"), 112050);
  assert.equal(yuanToCents(0.01), 1);
  assert.throws(() => yuanToCents(1120.555), /两位小数/);
  const shares = allocateCents(100, 18);
  assert.equal(shares.reduce((sum, value) => sum + value, 0), 100);
  assert.equal(shares.at(-1) - shares[0], 100 - 5 * 18);
  assert.equal(formatYuan(6222), "62.22元");
  assert.equal(formatYuan(6226), "62.26元");
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
    const sum = plan.workdays.reduce((total, day) => total + day.cents, 0);
    assert.equal(sum, 112000, `2026-${month} summed to ${sum}`);
    for (const day of plan.workdays) assert.equal(Number.isInteger(day.cents), true);
    const october = month === 10 ? plan : null;
    if (october) {
      assert.equal(october.workdays.some((day) => day.date === "2026-10-10"), true);
      assert.equal(october.workdays.some((day) => day.date === "2026-10-01"), false);
      assert.equal(october.workdays.at(-1).date, "2026-10-30");
      assert.ok(october.workdays.at(-1).cents >= october.workdays[0].cents);
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
  assert.equal(Number.isInteger(share), true);
  const paid = planFor(calendar, 2026, 10, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }]));
  assert.equal(isSalaryWorkday("2026-10-28", calendar, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }])), false);
  assert.equal(paid.workdays.reduce((sum, day) => sum + day.cents, 0), 112000);
  assert.equal(paid.workdays.some((day) => day.date === "2026-10-28"), false);
  assert.ok(paid.workdays[0].cents > original.workdays[0].cents);

  const unpaidAdj = indexAdjustments([{ date: "2026-10-28", kind: "unpaid_leave" }]);
  const unpaid = planFor(calendar, 2026, 10, unpaidAdj);
  assert.equal(unpaid.workdays.reduce((sum, day) => sum + day.cents, 0), 112000 - share);

  const deducted = planFor(calendar, 2026, 10, indexAdjustments([{ date: "2026-10-28", kind: "paid_leave" }]), {
    monthlyNetCents: 112000,
    paidLeaveKeepsSalary: false,
  });
  assert.equal(deducted.workdays.reduce((sum, day) => sum + day.cents, 0), 112000 - share);
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
  assert.equal(plan.workdays.reduce((sum, day) => sum + day.cents, 0), 112000);
  const thirteenth = plan.workdays.find((day) => day.date === "2026-10-13");
  assert.equal(thirteenth.overtimeCents, 880);
  const withOvertime = plan.workdays.reduce((sum, day) => sum + day.cents + day.overtimeCents, 0);
  assert.equal(withOvertime, 112000 + 880);
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
  assert.equal(october.workdays.reduce((sum, day) => sum + day.cents, 0), 112000);
  assert.equal(november.workdays.reduce((sum, day) => sum + day.cents, 0), 112000);
  const firstNovember = november.workdays[0].date;
  assert.equal(totalsThrough(october, "2026-10-30").before + totalsThrough(october, "2026-10-30").today, 112000);
  assert.equal(totalsThrough(november, firstNovember).before, 0);
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
  assert.match(morning.title, /待赚/);
  assert.match(morning.title, /还有1008天/);
  assert.ok([...morning.title].length <= TITLE_LIMIT);
  assert.equal(morning.title.includes("\n"), false);
  assert.match(morning.content, /打工自由助手｜早安/);
  assert.match(morning.content, new RegExp(`今日待赚：${formatYuan(figures.today).replace(".", "\\.")}`));
  assert.match(morning.content, /本月累计：/);
  assert.match(morning.content, /距离下班：9小时55分钟/);
  assert.match(morning.content, /这周已经过半|这周过半/);
  assert.match(morning.content, /不是银行卡到账/);
  assert.equal(morning.content.includes("周五了。做完今天"), false);
  assert.equal(library.morning.find((line) => line.id === morning.copyId).tags.includes("wednesday"), true);

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
  assert.match(evening.title, /到账/);
  assert.match(evening.title, /还有1008天/);
  assert.ok([...evening.title].length <= TITLE_LIMIT);
  assert.match(evening.content, /今日模拟到账：/);
  assert.match(evening.content, /本月剩余工作日：/);
  const eveningTotal = figures.before + figures.today;
  assert.match(evening.content, new RegExp(formatYuan(eveningTotal).replace(".", "\\.")));
  assert.equal(evening.content.includes(formatYuan(figures.before)), eveningTotal === figures.before);

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
  assert.match(monthEnd.content, /本月最后一个工作日/);
  assert.match(monthEnd.content, /本月剩余工作日：0天/);
  assert.match(monthEnd.content, /1120\.00元/);
  assert.equal(library.evening.find((line) => line.id === monthEnd.copyId).tags.includes("month_end"), true);
});

test("copy libraries stay large, gentle, and unique across 14 workdays", async () => {
  const { calendar, library, adjustments } = await fixtures();
  const banned = ["努力奋斗", "为单位奉献", "燃烧自己", "拼搏到底", "工作是人生的意义", "奋斗", "拼搏", "奉献", "内卷", "狼性", "996", "加班"];
  const blob = JSON.stringify(library) + JSON.stringify(CONTEXT_LINES) + JSON.stringify(ANNIVERSARY_DAY);
  for (const phrase of banned) assert.equal(blob.includes(phrase), false, phrase);
  assert.ok(library.morning.length >= 50);
  assert.ok(library.evening.length >= 50);
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
    todayCents: 112000,
    milestone: describeAnniversary("2019-08-01"),
    comfort: "照常做完就好，不必把今天过成一场考核。",
  });
  assert.equal([...crowded].length <= TITLE_LIMIT, true);
  assert.match(crowded, /待赚1120\.00/);
  assert.match(crowded, /还有3653天/);
  assert.equal(crowded.includes("\n"), false);
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
  assert.equal(october.workdays.reduce((sum, day) => sum + day.cents, 0), 112000);

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
  assert.match(anniversaryMorning.title, /十周年今天/);
  assert.match(anniversaryMorning.title, /不是辞职日/);
  assert.ok([...anniversaryMorning.title].length <= TITLE_LIMIT);
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
    if (String(url).endsWith(".send")) {
      content = JSON.parse(init.body).desp;
      return jsonResponse({ code: 0, data: {} });
    }
    return jsonResponse({ code: 200, data: { status: 2, errorMessage: "" } });
  };
  const logger = createLogger(["SCT1234567890abcdef"], { log() {}, error() {} });
  const options = {
    now: new Date("2029-08-01T00:05:00.000Z"),
    event: "schedule",
    schedule: "5 0 * * *",
    sendKey: "SCT1234567890abcdef",
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

test("Server酱 payload is title plus desp and logs omit the sendkey and salary", async () => {
  const logs = [];
  const calls = [];
  const sendKey = "SCT1234567890abcdef";
  const logger = createLogger([sendKey], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ href, body, method: init.method });
    if (href.endsWith(".send")) {
      return jsonResponse({ code: 0, message: "", data: { pushid: "88", readkey: "read-key-value" } });
    }
    return jsonResponse({ code: 0, data: { id: "88", title: body?.title || "hidden 1120" } });
  };
  const title = "待赚62.22｜还有1008天｜做完即可";
  const result = await deliverMessage({
    fetchImpl,
    sleep: async () => {},
    sendKey,
    title,
    desp: "今日待赚：62.22元\n本月累计：0.00元",
    logger,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stored, "yes");
  const sent = calls.find((call) => call.href.endsWith(".send"));
  assert.deepEqual(Object.keys(sent.body).sort(), ["desp", "title"]);
  assert.equal(sent.body.title, title);
  assert.match(sent.body.desp, /今日待赚：62\.22元/);
  assert.equal(sent.href.includes(sendKey), true);
  assert.equal(JSON.stringify(sent.body).includes(sendKey), false);
  assert.equal(calls.some((call) => call.href.includes("/push?")), true);
  const logged = logs.join("\n");
  assert.equal(logged.includes(sendKey), false);
  assert.equal(logged.includes("read-key-value"), false);
  assert.equal(logged.includes("62.22"), false);
  assert.equal(logged.includes("1120"), false);
  assert.match(logged, /code=0/);
  assert.match(safeReason(`balance 1120 key ${sendKey}`, logger.redact), /balance # key \[redacted\]/);
});

test("a non-zero Server酱 code is not delivery, and transport errors retry once", async () => {
  const logs = [];
  const sendKey = "SCT1234567890abcdef";
  const logger = createLogger([sendKey], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  let rejected = 0;
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => {
      rejected += 1;
      return jsonResponse({ code: 40001, message: `错误的Key ${sendKey} 额度 1120` });
    },
    sleep: async () => {},
    sendKey,
    title: "待赚62.22｜还有1008天｜做完即可",
    desp: "正文",
    logger,
    maxAttempts: 2,
  }), /拒绝/);
  assert.equal(rejected, 1);
  assert.equal(logs.join("\n").includes(sendKey), false);
  assert.equal(logs.join("\n").includes("1120"), false);

  let attempt = 0;
  const recovered = await deliverMessage({
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error(`network ${sendKey}`);
      return jsonResponse({ code: 0, data: {} });
    },
    sleep: async () => {},
    sendKey,
    title: "到账62.22｜还有1008天｜班结束了",
    desp: "正文",
    logger,
    maxAttempts: 2,
  });
  assert.equal(recovered.code, 0);
  assert.equal(attempt, 2);
  await assert.rejects(() => deliverMessage({
    fetchImpl: async () => jsonResponse({ code: 0, data: {} }),
    sleep: async () => {},
    sendKey: "sctp123tsecret",
    title: "t",
    desp: "d",
    logger,
  }), /Server酱³/);
});

test("a workday send is recorded once and skipped the second time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const logs = [];
  const logger = createLogger(["SCT1234567890abcdef"], { log: (line) => logs.push(line), error: (line) => logs.push(line) });
  let sends = 0;
  const fetchImpl = async (url) => {
    if (String(url).endsWith(".send")) {
      sends += 1;
      return jsonResponse({ code: 0, data: {} });
    }
    return jsonResponse({ code: 200, data: { status: 2, errorMessage: "" } });
  };
  const options = {
    now: new Date("2026-10-28T00:05:00.000Z"),
    event: "schedule",
    schedule: "5 0 * * *",
    sendKey: "SCT1234567890abcdef",
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
  assert.equal(JSON.stringify(state).includes("SCT1234567890abcdef"), false);
  assert.equal(JSON.stringify(state).includes("1120"), false);
  const second = await run(options);
  assert.equal(second.reason, "duplicate");
  assert.equal(sends, 1);
  const weekend = await run({ ...options, now: new Date("2026-10-31T00:05:00.000Z") });
  assert.equal(weekend.reason, "not-workday");
  const holiday = await run({ ...options, now: new Date("2026-09-30T16:05:00.000Z") });
  assert.equal(holiday.date, "2026-10-01");
  assert.equal(holiday.reason, "not-workday");
  const makeup = await run({ ...options, now: new Date("2026-10-10T00:05:00.000Z"), schedule: "5 0 * * *" });
  assert.equal(makeup.action, "sent");
  assert.equal(sends, 2);
  assert.equal(logs.join("\n").includes("SCT1234567890abcdef"), false);
  assert.equal(logs.join("\n").includes("元"), false);
  await rm(dir, { recursive: true, force: true });
});

test("a rejected Server酱 response does not mark the slot sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wage-remind-"));
  const statePath = join(dir, "state.json");
  let sends = 0;
  const fetchImpl = async () => {
    sends += 1;
    return jsonResponse({ code: 40001, message: "错误的Key" });
  };
  const logger = createLogger(["SCT1234567890abcdef"], { log() {}, error() {} });
  const options = {
    now: new Date("2026-10-28T10:05:00.000Z"),
    event: "schedule",
    schedule: "5 10 * * *",
    sendKey: "SCT1234567890abcdef",
    statePath,
    fetchImpl,
    sleep: async () => {},
    logger,
    maxAttempts: 2,
  };
  await assert.rejects(() => run(options), /拒绝/);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.sent["2026-10-28"], undefined);
  assert.equal(sends, 1);
  assert.equal(JSON.stringify(state).includes("SCT1234567890abcdef"), false);
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
    if (String(url).endsWith(".send")) {
      sends += 1;
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ["desp", "title"]);
      assert.equal(body.title, "通道测试｜不记工资｜不是正式提醒");
      assert.ok([...body.title].length <= TITLE_LIMIT);
      assert.match(body.desp, /【测试】/);
      assert.equal(body.desp.includes("今日待赚"), false);
      return jsonResponse({ code: 0, data: {} });
    }
    return jsonResponse({ code: 200, data: { status: 2, errorMessage: "" } });
  };
  const testRun = await run({
    now: new Date("2026-10-31T02:00:00.000Z"),
    event: "workflow_dispatch",
    slot: "test",
    sendKey: "SCT1234567890abcdef",
    statePath: join(dir, "state.json"),
    fetchImpl,
    sleep: async () => {},
    logger: createLogger(["SCT1234567890abcdef"], { log() {}, error() {} }),
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
      SERVERCHAN_SENDKEY: "SCT1234567890abcdef",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /action=dry-run/);
  assert.equal(output.includes("SCT1234567890abcdef"), false);
  assert.equal(output.includes("元"), false);
  assert.equal(output.includes("1120"), false);
});
