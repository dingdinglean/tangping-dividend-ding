import { countdownLine, describeAnniversary, tenureLine } from "./anniversary.mjs";
import { addDays, formatDuration, weekdayOf } from "./time.mjs";
import { assertYearCovered } from "./calendar.mjs";
import { hashText, selectCopy } from "./copy.mjs";
import { isLastWorkday, isSalaryWorkday, totalsThrough } from "./wage.mjs";
import { formatYuan, ratAdd } from "./money.mjs";

export const TITLE_LIMIT = 32;

const BARE_DAY = /^(?:周[一二三四五六日天]|星期[一二三四五六日天])(?:了|见|早上|晚上|下班|的班)?$/;

function clausesOf(text) {
  return String(text || "")
    .replace(/[\r\n｜|]/g, "")
    .split(/[。！？!?；;，,、]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function shortComfort(text, room) {
  const limit = Math.max(0, room);
  const cleaned = String(text || "").replace(/[\r\n｜|]/g, "").trim();
  const full = cleaned.replace(/[。！？!?；;，,、\s]+$/g, "");
  const parts = clausesOf(cleaned).filter((part) => !BARE_DAY.test(part) && part !== "测试" && part !== "打工自由助手");
  const fitting = parts.filter((part) => part !== full && [...part].length >= 2 && [...part].length <= limit);
  const preferred = fitting.find((part) => !/^(?:周|星期)/.test(part)) || fitting[0];
  let phrase = preferred || "";
  if (!phrase) {
    const source = parts[0] || full || "做完即可";
    const cap = Math.min(limit, Math.max(0, [...source].length - (source === full ? 1 : 0)));
    phrase = [...source].slice(0, cap).join("");
  }
  if ([...phrase].length > limit) phrase = [...phrase].slice(0, limit).join("");
  if ((phrase === full || phrase === cleaned) && phrase.length > 0) {
    phrase = [...phrase].slice(0, Math.max(0, Math.min(limit, [...phrase].length - 1))).join("");
  }
  if (phrase) return phrase;
  return [..."做完即可"].slice(0, limit).join("");
}

function amountLead(slot, todayAmount) {
  const money = formatYuan(todayAmount);
  return slot === "evening" ? `下班到账 +${money}` : `今日待赚 ${money}`;
}

export function buildNotificationTitle({ slot, todayAmount = null, todayCents = undefined, comfort }) {
  const amount = todayAmount !== null && todayAmount !== undefined ? todayAmount : todayCents;
  if (amount == null) return shortComfort(comfort, TITLE_LIMIT);
  const lead = amountLead(slot, amount);
  const prefix = `${lead}｜`;
  const room = TITLE_LIMIT - [...prefix].length;
  if (room <= 0) return [...lead].slice(0, TITLE_LIMIT).join("");
  const phrase = shortComfort(comfort, room);
  const title = phrase ? `${prefix}${phrase}` : lead;
  return [...title].slice(0, TITLE_LIMIT).join("").replace(/[\r\n]/g, "");
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

function datedOnPlan(plan, date) {
  return [...plan.workdays, ...plan.offDayOvertime].some((row) => row.date === date);
}

export function wageSummaryLines({ slot, now, plan, workEndMinutes }) {
  const { before, today, remaining } = totalsThrough(plan, now.date);
  const earned = slot === "morning" ? before : ratAdd(before, today);
  if (slot === "morning") {
    return [
      `今日待赚 ${formatYuan(today)}`,
      `本月累计 ${formatYuan(earned)}`,
      `距离下班：${formatDuration(workEndMinutes - now.minutesOfDay)}`,
    ];
  }
  return [
    `下班到账 +${formatYuan(today)}`,
    `本月累计 ${formatYuan(earned)}`,
    `本月剩余工作日：${remaining}天`,
  ];
}

export function buildAnniversaryMessage({ slot, milestone, wageLines = [], todayAmount = null, todayCents = undefined }) {
  const paragraphs = ANNIVERSARY_DAY[slot] || ANNIVERSARY_DAY.morning;
  const amount = todayAmount !== null && todayAmount !== undefined ? todayAmount : todayCents;
  const body = [];
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
    title: buildNotificationTitle({ slot, todayAmount: amount ?? null, comfort: paragraphs[0] }),
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
  const figures = totalsThrough(plan, now.date);
  const onPlan = datedOnPlan(plan, now.date);
  const summary = onPlan ? wageSummaryLines({ slot, now, plan, workEndMinutes }) : [];
  if (milestone.phase === "today") {
    return buildAnniversaryMessage({
      slot,
      milestone,
      wageLines: summary,
      todayAmount: onPlan ? figures.today : null,
    });
  }
  const contexts = reminderContexts({ date: now.date, slot, calendar, adjustments, plan, anniversary });
  const line = selectCopy(lines, { date: now.date, slot, contexts, recent });
  const notes = CONTEXT_ORDER
    .filter((name) => contexts.includes(name) && !line.tags.includes(name))
    .map((name) => CONTEXT_LINES[slot][name])
    .filter((note) => note !== line.text && !line.text.includes(note));
  const body = [...summary, "", countdownLine(milestone), tenureLine(milestone)];
  if (notes.length) {
    body.push("");
    for (const note of notes) body.push(note);
  }
  body.push("");
  body.push(line.text);
  body.push("");
  body.push(FOOTER);
  return {
    title: buildNotificationTitle({ slot, todayAmount: figures.today, comfort: line.text }),
    content: body.join("\n"),
    copyId: line.id,
    contexts,
  };
}

export function buildTestMessage(preview) {
  const lead = "【测试】这条只用来确认推送通道，不计入额外收入，也不改写今日早晚的发送记录。";
  if (!preview) {
    return {
      title: "不记工资｜只确认通道",
      content: `${lead}\n今天不是计薪工作日，所以这里不展示模拟工资。能看到这段文字，说明通道是通的。\n\n${FOOTER}`,
    };
  }
  return {
    title: preview.title,
    content: `${lead}\n\n${preview.content}`,
    copyId: preview.copyId,
  };
}

export { FOOTER, CONTEXT_LINES, ANNIVERSARY_DAY };
