export function yuanToCents(yuan) {
  if (typeof yuan === "string") return parseYuanText(yuan.trim());
  if (typeof yuan !== "number" || !Number.isFinite(yuan) || yuan < 0) {
    throw new Error("月到手工资无效");
  }
  const cents = Math.round(yuan * 100);
  if (Math.abs(yuan * 100 - cents) > 1e-6) throw new Error("月到手工资须为最多两位小数");
  return cents;
}

function parseYuanText(text) {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error("月到手工资须为最多两位小数的非负数字");
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function allocateCents(totalCents, count) {
  if (!Number.isInteger(totalCents) || totalCents < 0) throw new Error("金额必须是非负整数分");
  if (!Number.isInteger(count) || count <= 0) throw new Error("计薪天数必须大于 0");
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, index) => base + (index === count - 1 ? remainder : 0));
}

export function formatYuan(cents) {
  if (!Number.isInteger(cents)) throw new Error("金额必须是整数分");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}元`;
}
