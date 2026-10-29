const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Asia/Shanghai send windows for automatic / manual morning|evening pushes. */
export const SEND_WINDOWS = Object.freeze({
  morning: Object.freeze({ startMinutes: 7 * 60 + 30, endMinutes: 9 * 60 + 30 }), // 07:30–09:30
  evening: Object.freeze({ startMinutes: 17 * 60 + 30, endMinutes: 19 * 60 + 30 }), // 17:30–19:30
});

export function assertDate(date) {
  if (!DATE_RE.test(date)) throw new Error("日期须为 YYYY-MM-DD");
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error("日期不存在");
  }
  return date;
}

export function weekdayOf(date) {
  assertDate(date);
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDays(date, days) {
  assertDate(date);
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return utc.toISOString().slice(0, 10);
}

export function datesInMonth(year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("年月无效");
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dates = [];
  for (let day = 1; day <= last; day += 1) {
    dates.push(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return dates;
}

export function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  if (!match) throw new Error("时间须为 HH:MM");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("时间无效");
  return hour * 60 + minute;
}

export function formatDuration(minutes) {
  if (!Number.isInteger(minutes)) throw new Error("时长无效");
  if (minutes <= 0) return "已经到下班时间";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分钟`;
  if (rest === 0) return `${hours}小时`;
  return `${hours}小时${rest}分钟`;
}

export function shanghaiNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const bag = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const hour = bag.hour === "24" ? "00" : bag.hour;
  const minute = bag.minute;
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    minutesOfDay: Number(hour) * 60 + Number(minute),
  };
}

/** True when slot is morning/evening and minutesOfDay falls in its Shanghai window (inclusive). test/unknown → true. */
export function inSendWindow(slot, minutesOfDay) {
  const window = SEND_WINDOWS[slot];
  if (!window) return true;
  if (!Number.isInteger(minutesOfDay)) return false;
  return minutesOfDay >= window.startMinutes && minutesOfDay <= window.endMinutes;
}
