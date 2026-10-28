import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeAnniversary, normalizeAnniversary } from "./anniversary.mjs";
import { loadCalendar, loadHolidayDirectory } from "./calendar.mjs";
import { loadCopyLibrary } from "./copy.mjs";
import { buildAnniversaryMessage, buildReminder, buildTestMessage, wageSummaryLines } from "./message.mjs";
import { yuanToCents } from "./money.mjs";
import { createLogger, deliverMessage } from "./bark.mjs";
import { loadState, rememberCopy, saveState, slotRecord, withSlot } from "./state.mjs";
import { parseClock, shanghaiNow } from "./time.mjs";
import { buildMonthPlan, indexAdjustments, isSalaryWorkday, totalsThrough } from "./wage.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function parseConfig(raw) {
  if (raw.timezone !== "Asia/Shanghai") throw new Error("目前只支持 Asia/Shanghai");
  const monthlyNetCents = yuanToCents(raw.monthlyNetYuan);
  if (monthlyNetCents <= 0) throw new Error("月到手工资必须大于 0");
  const workStartMinutes = parseClock(raw.workStart);
  const workEndMinutes = parseClock(raw.workEnd);
  if (workEndMinutes <= workStartMinutes) throw new Error("下班时间必须晚于上班时间");
  return {
    timezone: raw.timezone,
    monthlyNetCents,
    workStartMinutes,
    workEndMinutes,
    morningEnabled: raw.morningEnabled !== false,
    eveningEnabled: raw.eveningEnabled !== false,
    paidLeaveKeepsSalary: raw.paidLeaveKeepsSalary !== false,
    holidayOverrides: raw.holidayOverrides || [],
    adjustments: raw.adjustments || [],
    workAnniversary: normalizeAnniversary(raw.workAnniversary),
  };
}

export function resolveSlot({ event, schedule, slot }) {
  if (event === "schedule") {
    const cron = String(schedule || "").trim().replace(/\s+/g, " ");
    if (cron === "5 0 * * *") return "morning";
    if (cron === "5 10 * * *") return "evening";
    throw new Error("未知的定时表达式");
  }
  if (slot === "morning" || slot === "evening" || slot === "test") return slot;
  throw new Error("请指定 morning、evening 或 test");
}

function enabled(config, slot) {
  if (slot === "morning") return config.morningEnabled;
  if (slot === "evening") return config.eveningEnabled;
  return true;
}

export async function run(options = {}) {
  const root = options.root || packageRoot;
  const statePath = options.statePath || join(root, ".state", "state.json");
  const logger = options.logger || createLogger([options.deviceKey]);
  let state = await loadState(statePath);
  await saveState(statePath, state);

  const config = parseConfig(JSON.parse(await readFile(options.configPath || join(root, "config.json"), "utf8")));
  const calendar = loadCalendar(
    await loadHolidayDirectory(options.holidayDir || join(root, "data", "holidays")),
    config.holidayOverrides,
  );
  const library = await loadCopyLibrary(options.copyPath || join(root, "data", "copy.json"));
  const adjustments = indexAdjustments(config.adjustments);
  const now = shanghaiNow(options.now || new Date());
  const slot = resolveSlot({ event: options.event || "workflow_dispatch", schedule: options.schedule, slot: options.slot });
  const milestone = describeAnniversary(now.date, config.workAnniversary);
  const [year, month] = now.date.split("-").map(Number);
  let plan = null;
  let workday = false;
  try {
    plan = buildMonthPlan({ year, month, calendar, config, adjustments });
    workday = isSalaryWorkday(now.date, calendar, adjustments);
  } catch (error) {
    if (!(milestone.phase === "today" && String(error?.message || "").includes("法定节假日数据"))) throw error;
  }
  const base = { slot, date: now.date };
  const anniversaryToday = milestone.phase === "today";

  if (slot !== "test" && !workday && !options.force && !anniversaryToday) {
    logger.info(`wage-remind action=skipped reason=not-workday slot=${slot} date=${now.date}`);
    return { ...base, action: "skipped", reason: "not-workday" };
  }
  if (slot !== "test" && !enabled(config, slot) && !options.force) {
    logger.info(`wage-remind action=skipped reason=disabled slot=${slot} date=${now.date}`);
    return { ...base, action: "skipped", reason: "disabled" };
  }
  const record = slot === "test" ? null : slotRecord(state, now.date, slot);
  if (record?.status === "sent" && !options.force) {
    logger.info(`wage-remind action=skipped reason=duplicate slot=${slot} date=${now.date}`);
    return { ...base, action: "skipped", reason: "duplicate" };
  }

  const previewSlot = slot === "test" ? (now.minutesOfDay < config.workEndMinutes ? "morning" : "evening") : slot;
  const wageLines = plan && (workday || options.force)
    ? wageSummaryLines({ slot: previewSlot, now, plan, workEndMinutes: config.workEndMinutes })
    : [];
  let message;
  if (anniversaryToday && slot !== "test") {
    message = buildAnniversaryMessage({
      slot: previewSlot,
      milestone,
      wageLines,
      todayAmount: wageLines.length ? totalsThrough(plan, now.date).today : null,
    });
  } else if (plan && (workday || options.force)) {
    message = buildReminder({
      slot: previewSlot,
      now,
      plan,
      calendar,
      adjustments,
      lines: library[previewSlot],
      recent: state.recent,
      workEndMinutes: config.workEndMinutes,
      anniversary: config.workAnniversary,
    });
  } else {
    message = null;
  }
  if (slot === "test") message = buildTestMessage(message);

  if (options.dryRun) {
    logger.info(`wage-remind action=dry-run slot=${slot} date=${now.date} bytes=${message.content.length}`);
    return { ...base, action: "dry-run", bytes: message.content.length };
  }
  if (!options.deviceKey) throw new Error("缺少 BARK_DEVICE_KEY");

  const result = await deliverMessage({
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    deviceKey: options.deviceKey,
    title: message.title,
    body: message.content,
    logger,
    maxAttempts: options.maxAttempts,
  });

  if (slot !== "test") {
    state = withSlot(state, now.date, slot, { status: "sent", at: new Date().toISOString() });
    if (message.copyId) state = { ...state, recent: rememberCopy(state.recent, { date: now.date, slot, id: message.copyId }) };
    await saveState(statePath, state);
  }
  logger.info(`wage-remind action=sent slot=${slot} date=${now.date} resent=${Boolean(result.resent)}`);
  return { ...base, action: "sent", resent: result.resent };
}
