function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x || 1n;
}

function fromBig(num, den) {
  if (den === 0n) throw new Error("金额必须是有理数");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den);
  num /= g;
  den /= g;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (num > max || num < -max || den > max) throw new Error("金额超出安全范围");
  return { num: Number(num), den: Number(den) };
}

export function rational(num, den = 1) {
  if (typeof num !== "number" || typeof den !== "number" || !Number.isInteger(num) || !Number.isInteger(den)) {
    throw new Error("金额必须是有理数");
  }
  return fromBig(BigInt(num), BigInt(den));
}

export function ratAdd(left, right) {
  return fromBig(
    BigInt(left.num) * BigInt(right.den) + BigInt(right.num) * BigInt(left.den),
    BigInt(left.den) * BigInt(right.den),
  );
}

export function ratSub(left, right) {
  return fromBig(
    BigInt(left.num) * BigInt(right.den) - BigInt(right.num) * BigInt(left.den),
    BigInt(left.den) * BigInt(right.den),
  );
}

export function ratDiv(amount, count) {
  if (!Number.isInteger(count) || count <= 0) throw new Error("计薪天数必须大于 0");
  return fromBig(BigInt(amount.num), BigInt(amount.den) * BigInt(count));
}

export function ratCmp(left, right) {
  const a = BigInt(left.num) * BigInt(right.den);
  const b = BigInt(right.num) * BigInt(left.den);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function ratEq(left, right) {
  return ratCmp(left, right) === 0;
}

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

function asRational(amount) {
  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) throw new Error("金额必须是整数分或有理数");
    return rational(amount, 1);
  }
  if (!amount || !Number.isInteger(amount.num) || !Number.isInteger(amount.den) || amount.den <= 0) {
    throw new Error("金额必须是整数分或有理数");
  }
  return amount;
}

export function roundCents(amount) {
  const rat = asRational(amount);
  const negative = rat.num < 0;
  const num = BigInt(Math.abs(rat.num));
  const den = BigInt(rat.den);
  let cents = num / den;
  const remainder = num % den;
  if (remainder * 2n >= den) cents += 1n;
  return negative ? -cents : cents;
}

export function formatYuan(amount) {
  const cents = roundCents(amount);
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const sign = negative ? "-" : "";
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}¥${(abs / 100n).toString()}.${frac}`;
}
