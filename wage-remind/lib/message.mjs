import { addDays, formatDuration, weekdayOf } from "./time.mjs";
import { assertYearCovered } from "./calendar.mjs";
import { selectCopy } from "./copy.mjs";
import { isLastWorkday, isSalaryWorkday, totalsThrough } from "./wage.mjs";
import { formatYuan } from "./money.mjs";

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

export function buildReminder({ slot, now, plan, calendar, adjustments, lines, recent, workEndMinutes }) {
  const { before, today, remaining } = totalsThrough(plan, now.date);
  const contexts = dayContexts(now.date, calendar, adjustments, plan);
  const line = selectCopy(lines, { date: now.date, slot, contexts, recent });
  const notes = CONTEXT_ORDER.filter((name) => contexts.includes(name)).map((name) => CONTEXT_LINES[slot][name]);
  const body = [];
  if (slot === "morning") {
    body.push(`今日待赚：${formatYuan(today)}`);
    body.push(`本月累计：${formatYuan(before)}`);
    body.push(`距离下班：${formatDuration(workEndMinutes - now.minutesOfDay)}`);
  } else {
    body.push(`今日模拟到账：${formatYuan(today)}`);
    body.push(`本月累计：${formatYuan(before + today)}`);
    body.push(`本月剩余工作日：${remaining}天`);
  }
  body.push("");
  for (const note of notes) body.push(note);
  if (notes.length) body.push("");
  body.push(line.text);
  body.push("");
  body.push(FOOTER);
  return {
    title: slot === "morning" ? "打工自由助手｜早安" : "打工自由助手｜下班啦",
    content: body.join("\n"),
    copyId: line.id,
    contexts,
  };
}

export function buildTestMessage(preview) {
  const lead = "【测试】这条只用来确认推送通道，不计入额外收入，也不改写今日早晚的发送记录。";
  if (!preview) {
    return {
      title: "打工自由助手｜测试",
      content: `${lead}\n今天不是计薪工作日，所以这里不展示模拟工资。能看到这段纯文本，说明通道是通的。\n\n${FOOTER}`,
    };
  }
  return {
    title: "打工自由助手｜测试",
    content: `${lead}\n\n${preview.content}`,
    copyId: preview.copyId,
  };
}

export { FOOTER, CONTEXT_LINES };
