// NYSE/Nasdaq regular-equity calendar. Dates are exchange-local ISO dates.
// The rules cover the recurring official holidays and the scheduled early closes
// relevant to EOD validation; extraordinary exchange closures can be added here.
const DAY = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const fromParts = (year, month, day) => new Date(Date.UTC(year, month - 1, day));
const addDays = (value, days) => iso(Date.parse(`${value}T00:00:00Z`) + days * DAY);
const weekday = (value) => new Date(`${value}T00:00:00Z`).getUTCDay();
const nthWeekday = (year, month, targetDay, occurrence) => {
  const first = fromParts(year, month, 1);
  const offset = (targetDay - first.getUTCDay() + 7) % 7;
  return iso(fromParts(year, month, 1 + offset + (occurrence - 1) * 7));
};
const lastWeekday = (year, month, targetDay) => {
  const last = fromParts(year, month + 1, 0);
  return iso(new Date(last.getTime() - ((last.getUTCDay() - targetDay + 7) % 7) * DAY));
};
const observed = (year, month, day) => {
  const value = iso(fromParts(year, month, day));
  return weekday(value) === 6 ? addDays(value, -1) : weekday(value) === 0 ? addDays(value, 1) : value;
};

function easterSunday(year) {
  const a = year % 19; const b = Math.floor(year / 100); const c = year % 100;
  const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return iso(fromParts(year, Math.floor((h + l - 7 * m + 114) / 31), (h + l - 7 * m + 114) % 31 + 1));
}

function regularHolidays(year) {
  return [
    observed(year, 1, 1),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    addDays(easterSunday(year), -2),
    lastWeekday(year, 5, 1),
    ...(year >= 2022 ? [observed(year, 6, 19)] : []),
    observed(year, 7, 4),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observed(year, 12, 25),
  ];
}

// Closures declared by NYSE/Nasdaq in addition to the recurring calendar.
const SPECIAL_CLOSURES = new Set([
  "2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14",
  "2004-06-11", "2007-01-02", "2012-10-29", "2012-10-30",
  "2018-12-05",
]);

export function isUsTradingDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || weekday(value) === 0 || weekday(value) === 6 || SPECIAL_CLOSURES.has(value)) return false;
  const year = Number(value.slice(0, 4));
  // Include adjacent years because New Year's Day may be observed on Dec 31.
  return ![year - 1, year, year + 1].flatMap(regularHolidays).includes(value);
}

export function isEarlyClose(value) {
  if (!isUsTradingDay(value)) return false;
  const year = Number(value.slice(0, 4));
  const thanksgivingFriday = addDays(nthWeekday(year, 11, 4, 4), 1);
  if (value === thanksgivingFriday) return true;
  // NYSE schedules a 1pm ET close on Christmas Eve when it is an open weekday.
  if (value === `${year}-12-24`) return true;
  // Independence Day early-close rules: the preceding open session closes early,
  // except when the exchange observes the holiday as a full-day closure.
  const july4 = `${year}-07-04`;
  let prior = addDays(july4, -1);
  while (!isUsTradingDay(prior) && prior >= `${year}-06-29`) prior = addDays(prior, -1);
  return value === prior;
}

function nyParts(now) {
  const pieces = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(now));
  return Object.fromEntries(pieces.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function latestCompletedUsTradingSession(now = Date.now()) {
  const parts = nyParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  let date = today;
  if (isUsTradingDay(date) && minutes >= (isEarlyClose(date) ? 13 * 60 : 16 * 60)) {
    return { date, earlyClose: isEarlyClose(date) };
  }
  do { date = addDays(date, -1); } while (!isUsTradingDay(date));
  return { date, earlyClose: isEarlyClose(date) };
}

export function sessionDateFromTimestamp(value) {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  const parts = nyParts(parsed);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
