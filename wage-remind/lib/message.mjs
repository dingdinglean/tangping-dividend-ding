import { describeAnniversary } from "./anniversary.mjs";
import { addDays, weekdayOf } from "./time.mjs";
import { assertYearCovered } from "./calendar.mjs";
import { hashText, selectCopy } from "./copy.mjs";
import { isLastWorkday, isSalaryWorkday, totalsThrough } from "./wage.mjs";
import { formatYuan, ratAdd } from "./money.mjs";

function notificationText(lines) {
  const seen = new Set();
  const kept = [];
  for (const raw of lines) {
    const text = String(raw ?? "").replace(/\r\n/g, "\n").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    kept.push(text);
  }
  return kept.join("\n");
}

export function buildNotificationTitle({ slot, todayAmount = null, todayCents = undefined, fallback = "" }) {
  const amount = todayAmount !== null && todayAmount !== undefined ? todayAmount : todayCents;
  const mark = slot === "evening" ? "💚" : "☀️";
  if (amount == null) {
    const plain = String(fallback || "").replace(/[\r\n｜|]/g, "").trim();
    return plain || `${mark} ${slot === "evening" ? "今日收入" : "今日待赚"}`;
  }
  const money = formatYuan(amount);
  return slot === "evening" ? `${mark} 今日收入 +${money}` : `${mark} 今日待赚 ${money}`;
}

const CONTEXT_LINES = {
  morning: {
    month_end: "今天是本月最后一个工作日。做完今天，这个月的模拟劳动收入就齐了。",
    pre_holiday: "假期前的工作日。今天做完，就可以把工作留在工位。",
    friday: "周五了。做完今天，周末把时间还给自己。",
    wednesday: "周三了，这周已经过半。",
    monday: "周一了。不用一开始就进入状态，按平时的完成度做完即可。",
  },
  evening: {
    month_end: "本月最后一个工作日结束。这个月的模拟劳动收入已经记完。",
    pre_holiday: "假期前的工作做完了。接下来的休息是你的，不必用工作填满。",
    friday: "周五的班结束了。周末从这一刻开始，不用再把精力留在工作上。",
    wednesday: "周三的班结束了，这周已经过半。",
    monday: "周一的班已经上完。今天到此为止就很好。",
  },
};

const ANNIVERSARY_DAY = {
  morning: [
    "今天是上班十周年，不是辞职日。这十年的班都算数。留下、离开，或先歇一歇，都可以慢慢决定，不必今天做完。",
  ],
  evening: [
    "十年的班到今天为止，值得被承认。这不是离职通知，也不是辞职日。接下来怎么过，可以慢慢选，不必今晚决定。",
  ],
};

export function anniversaryOccasion(date, slot) {
  return hashText(`${date}:${slot}:anniversary`) % 5 === 0;
}

export function reminderContexts({ date, slot, calendar, adjustments, plan, anniversary }) {
  const contexts = dayContexts(date, calendar, adjustments, plan);
  const milestone = describeAnniversary(date, anniversary);
  if (milestone.phase === "before" && anniversaryOccasion(date, slot)) {
    contexts.splice(contexts.indexOf("general"), 0, "anniversary");
  }
  return contexts;
}

function datedOnPlan(plan, date) {
  return [...plan.workdays, ...plan.offDayOvertime].some((row) => row.date === date);
}

export function countdownNotice(milestone) {
  if (milestone.phase === "after") return "⏳ 十周年倒计时：已达成";
  if (milestone.phase === "today") return "⏳ 十周年倒计时：今天";
  return `⏳ 十周年倒计时：${milestone.daysLeft}天`;
}

export function cumulativeLine(slot, now, plan) {
  const { before, today } = totalsThrough(plan, now.date);
  const earned = slot === "morning" ? before : ratAdd(before, today);
  return `💰 本月累计：${formatYuan(earned)}`;
}

export function wageSummaryLines({ slot, now, plan }) {
  return [cumulativeLine(slot, now, plan)];
}

export function buildAnniversaryMessage({ slot, milestone, wageLines = [], todayAmount = null, todayCents = undefined }) {
  const memorial = (ANNIVERSARY_DAY[slot] || ANNIVERSARY_DAY.morning)[0];
  const amount = todayAmount !== null && todayAmount !== undefined ? todayAmount : todayCents;
  return {
    title: buildNotificationTitle({
      slot,
      todayAmount: amount ?? null,
      fallback: slot === "evening" ? "💚 上班十周年" : "☀️ 上班十周年",
    }),
    content: notificationText([...wageLines, countdownNotice(milestone), memorial]),
    copyId: null,
    contexts: ["anniversary-day"],
  };
}

export function isPreHoliday(date, calendar, adjustments) {
  let cursor = addDays(date, 1);
  for (let step = 0; step < 16; step += 1) {
    assertYearCovered(calendar, Number(cursor.slice(0, 4)));
    if (isSalaryWorkday(cursor, calendar, adjustments)) return false;
    if (calendar.byDate.get(cursor)?.isOffDay) return true;
    cursor = addDays(cursor, 1);
  }
  return false;
}

export function weekendIsAhead(date, calendar, adjustments) {
  if (weekdayOf(date) !== 5) return false;
  return !isSalaryWorkday(addDays(date, 1), calendar, adjustments)
    && !isSalaryWorkday(addDays(date, 2), calendar, adjustments);
}

export function dayContexts(date, calendar, adjustments, plan) {
  const contexts = [];
  if (isLastWorkday(plan, date)) contexts.push("month_end");
  if (isPreHoliday(date, calendar, adjustments)) contexts.push("pre_holiday");
  if (weekendIsAhead(date, calendar, adjustments)) contexts.push("friday");
  if (weekdayOf(date) === 3) contexts.push("wednesday");
  if (weekdayOf(date) === 1) contexts.push("monday");
  contexts.push("general");
  return contexts;
}

export function buildReminder({ slot, now, plan, calendar, adjustments, lines, recent, anniversary }) {
  const milestone = describeAnniversary(now.date, anniversary);
  const figures = totalsThrough(plan, now.date);
  const onPlan = datedOnPlan(plan, now.date);
  if (milestone.phase === "today") {
    return buildAnniversaryMessage({
      slot,
      milestone,
      wageLines: onPlan ? wageSummaryLines({ slot, now, plan }) : [],
      todayAmount: onPlan ? figures.today : null,
    });
  }
  const contexts = reminderContexts({ date: now.date, slot, calendar, adjustments, plan, anniversary });
  const line = selectCopy(lines, { date: now.date, slot, contexts, recent });
  const body = [countdownNotice(milestone), line.text];
  if (onPlan) body.unshift(cumulativeLine(slot, now, plan));
  return {
    title: buildNotificationTitle({ slot, todayAmount: onPlan ? figures.today : null }),
    content: notificationText(body),
    copyId: line.id,
    contexts,
  };
}

export function buildTestMessage(preview, slot = "morning") {
  const baseTitle = preview?.title || (slot === "evening" ? "💚 确认推送" : "☀️ 确认推送");
  const title = baseTitle.includes("测试") ? baseTitle : `【测试】${baseTitle}`;
  if (!preview) {
    return {
      title,
      content: "【测试】\n今天不是计薪日。",
    };
  }
  return {
    title,
    content: notificationText(["【测试】", preview.content]),
    copyId: preview.copyId,
  };
}

export { CONTEXT_LINES, ANNIVERSARY_DAY };
