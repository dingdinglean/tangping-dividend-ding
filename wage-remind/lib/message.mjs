import { countdownLine, describeAnniversary, tenureLine } from "./anniversary.mjs";
import { addDays, formatDuration, weekdayOf } from "./time.mjs";
import { assertYearCovered } from "./calendar.mjs";
import { hashText, selectCopy } from "./copy.mjs";
import { isLastWorkday, isSalaryWorkday, totalsThrough } from "./wage.mjs";
import { formatYuan } from "./money.mjs";

export const TITLE_LIMIT = 32;

function compactComfort(text, room) {
  const cleaned = String(text || "做完即可").replace(/[\r\n｜|]/g, "").trim();
  const sentence = cleaned.split(/[。！？]/)[0] || "做完即可";
  return [...sentence].slice(0, Math.max(0, room)).join("");
}

export function buildNotificationTitle({ slot, todayCents, milestone, comfort }) {
  const amount = todayCents == null
    ? "今日休息"
    : `${slot === "evening" ? "到账" : "待赚"}${formatYuan(todayCents).replace(/元$/, "")}`;
  const countdown = milestone.phase === "today"
    ? "十周年今天"
    : milestone.phase === "after"
      ? "十周年已达成"
      : `还有${milestone.daysLeft}天`;
  const prefix = `${amount}｜${countdown}｜`;
  const title = `${prefix}${compactComfort(comfort, TITLE_LIMIT - [...prefix].length)}`.replace(/[\r\n]/g, "");
  return [...title].slice(0, TITLE_LIMIT).join("");
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

const CONTEXT_ORDER = ["month_end", "pre_holiday", "friday", "wednesday", "monday"];

const FOOTER = "—— 以上为按工作日估算的模拟收入，不是银行卡到账。";

const ANNIVERSARY_DAY = {
  morning: [
    "这十年的付出是真实的，也都算数。",
    "今天是上班十周年，不是辞职日，也没有人替你决定下一步。",
    "你拥有重新选择生活的权利：继续、换一种方式，或者只是先把今天过完。",
  ],
  evening: [
    "十年的班，到这个纪念日为止，值得被好好承认。",
    "这不是离职通知。今天不是辞职日。",
    "留下、离开，或先休息一阵，都是你的权利。选择可以慢慢做。",
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

export function wageSummaryLines({ slot, now, plan, workEndMinutes }) {
  const { before, today, remaining } = totalsThrough(plan, now.date);
  if (slot === "morning") {
    return [
      `今日待赚：${formatYuan(today)}`,
      `本月累计：${formatYuan(before)}`,
      `距离下班：${formatDuration(workEndMinutes - now.minutesOfDay)}`,
    ];
  }
  return [
    `今日模拟到账：${formatYuan(today)}`,
    `本月累计：${formatYuan(before + today)}`,
    `本月剩余工作日：${remaining}天`,
  ];
}

export function buildAnniversaryMessage({ slot, milestone, wageLines = [], todayCents = null }) {
  const paragraphs = ANNIVERSARY_DAY[slot] || ANNIVERSARY_DAY.morning;
  const heading = slot === "morning" ? "打工自由助手｜早安" : "打工自由助手｜下班啦";
  const body = [heading];
  for (const line of wageLines) body.push(line);
  if (wageLines.length) body.push("");
  body.push(countdownLine(milestone));
  body.push(tenureLine(milestone));
  body.push("");
  for (const paragraph of paragraphs) body.push(paragraph);
  if (wageLines.length) {
    body.push("");
    body.push(FOOTER);
  }
  return {
    title: buildNotificationTitle({ slot, todayCents, milestone, comfort: "不是辞职日" }),
    content: body.join("\n"),
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

export function buildReminder({ slot, now, plan, calendar, adjustments, lines, recent, workEndMinutes, anniversary }) {
  const milestone = describeAnniversary(now.date, anniversary);
  const summary = wageSummaryLines({ slot, now, plan, workEndMinutes });
  const todayCents = totalsThrough(plan, now.date).today;
  if (milestone.phase === "today") {
    return buildAnniversaryMessage({ slot, milestone, wageLines: summary, todayCents });
  }
  const contexts = reminderContexts({ date: now.date, slot, calendar, adjustments, plan, anniversary });
  const line = selectCopy(lines, { date: now.date, slot, contexts, recent });
  const notes = CONTEXT_ORDER.filter((name) => contexts.includes(name)).map((name) => CONTEXT_LINES[slot][name]);
  const body = [...summary, countdownLine(milestone), tenureLine(milestone), ""];
  for (const note of notes) body.push(note);
  if (notes.length) body.push("");
  body.push(line.text);
  body.push("");
  body.push(FOOTER);
  const heading = slot === "morning" ? "打工自由助手｜早安" : "打工自由助手｜下班啦";
  return {
    title: buildNotificationTitle({ slot, todayCents, milestone, comfort: line.text }),
    content: [heading, ...body].join("\n"),
    copyId: line.id,
    contexts,
  };
}

export function buildTestMessage(preview) {
  const lead = "【测试】这条只用来确认推送通道，不计入额外收入，也不改写今日早晚的发送记录。";
  if (!preview) {
    return {
      title: "通道测试｜不记工资｜不是正式提醒",
      content: `${lead}\n今天不是计薪工作日，所以这里不展示模拟工资。能看到这段纯文本，说明通道是通的。\n\n${FOOTER}`,
    };
  }
  return {
    title: [...`测试｜${preview.title}`].slice(0, TITLE_LIMIT).join(""),
    content: `${lead}\n\n${preview.content}`,
    copyId: preview.copyId,
  };
}

export { FOOTER, CONTEXT_LINES, ANNIVERSARY_DAY };
