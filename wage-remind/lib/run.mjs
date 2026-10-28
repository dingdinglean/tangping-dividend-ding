import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCalendar, loadHolidayDirectory } from "./calendar.mjs";
import { loadCopyLibrary } from "./copy.mjs";
import { buildReminder, buildTestMessage } from "./message.mjs";
import { yuanToCents } from "./money.mjs";
import { createLogger, deliverMessage } from "./pushplus.mjs";
import { loadState, rememberCopy, saveState, slotRecord, withSlot } from "./state.mjs";
import { parseClock, shanghaiNow } from "./time.mjs";
import { buildMonthPlan, indexAdjustments, isSalaryWorkday } from "./wage.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function parseConfig(raw) {
  if (raw.timezone !== "Asia/Shanghai") throw new Error("目前只支持 Asia/Shanghai");
  const monthlyNetCents = yuanToCents(raw.monthlyNetYuan);
  if (monthlyNetCents <= 0) throw new Error("月到手工资必须大于 0");
  const workStartMinutes = parseClock(raw.workStart);
  const workEndMinutes = parseClock(raw.workEnd);
  if (workEndMinutes <= workStartMinutes) throw new Error("下班时间必须晚于上班时间");
  const channel = raw.channel || "wechat";
  if (!["wechat", "clawbot"].includes(channel)) throw new Error("channel 只支持 wechat 或 clawbot");
  return {
    timezone: raw.timezone,
    monthlyNetCents,
    workStartMinutes,
    workEndMinutes,
    morningEnabled: raw.morningEnabled !== false,
    eveningEnabled: raw.eveningEnabled !== false,
    channel,
    paidLeaveKeepsSalary: raw.paidLeaveKeepsSalary !== false,
    holidayOverrides: raw.holidayOverrides || [],
    adjustments: raw.adjustments || [],
  };
}

export function resolveChannel(envChannel, configChannel) {
  const value = String(envChannel || "").trim() || configChannel || "wechat";
  if (!["wechat", "clawbot"].includes(value)) throw new Error("推送渠道只支持 wechat 或 clawbot");
  return value;
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
  const logger = options.logger || createLogger([options.token, options.secretKey]);
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
  const channel = resolveChannel(options.channel, config.channel);
  const [year, month] = now.date.split("-").map(Number);
  const plan = buildMonthPlan({ year, month, calendar, config, adjustments });
  const workday = isSalaryWorkday(now.date, calendar, adjustments);
  const base = { slot, date: now.date };

  if (slot !== "test" && !workday && !options.force) {
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
  const preview = workday || options.force
    ? buildReminder({
      slot: previewSlot,
      now,
      plan,
      calendar,
      adjustments,
      lines: library[previewSlot],
      recent: state.recent,
      workEndMinutes: config.workEndMinutes,
    })
    : null;
  const message = slot === "test" ? buildTestMessage(preview) : preview;

  if (options.dryRun) {
    logger.info(`wage-remind action=dry-run slot=${slot} date=${now.date} bytes=${message.content.length}`);
    return { ...base, action: "dry-run", bytes: message.content.length };
  }
  if (!options.token) throw new Error("缺少 PUSHPLUS_TOKEN");

  const result = await deliverMessage({
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    token: options.token,
    secretKey: options.secretKey || "",
    channel,
    title: message.title,
    content: message.content,
    previousShortCode: record?.status === "pending" && !options.force ? record.shortCode : "",
    logger,
    maxAttempts: options.maxAttempts,
    pollAttempts: options.pollAttempts,
    pollIntervalMs: options.pollIntervalMs,
    onAccepted: async (shortCode) => {
      if (slot === "test") return;
      state = withSlot(state, now.date, slot, { status: "pending", shortCode, at: new Date().toISOString() });
      await saveState(statePath, state);
    },
  });

  if (slot !== "test") {
    state = withSlot(state, now.date, slot, { status: "sent", at: new Date().toISOString() });
    if (message.copyId) state = { ...state, recent: rememberCopy(state.recent, { date: now.date, slot, id: message.copyId }) };
    await saveState(statePath, state);
  }
  logger.info(`wage-remind action=sent slot=${slot} date=${now.date} channel=${channel}`);
  return { ...base, action: "sent", channel, resent: result.resent };
}
