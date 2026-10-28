import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const year = process.argv[2];
if (!/^\d{4}$/.test(year || "")) {
  console.error("用法: node wage-remind/refresh-holidays.mjs <年份>");
  process.exit(1);
}

const url = `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
const response = await fetch(url);
if (!response.ok) {
  console.error(`没有拉到 ${year} 年放假安排（HTTP ${response.status}）`);
  process.exit(1);
}
const data = await response.json();
if (data.year !== Number(year) || !Array.isArray(data.days) || data.days.length === 0) {
  console.error("上游还没有这一年的国务院放假安排，拒绝写入空日历");
  process.exit(1);
}
const target = join(dirname(fileURLToPath(import.meta.url)), "data", "holidays", `${year}.json`);
await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
console.log(`已写入 ${year} 年节假日，共 ${data.days.length} 天`);
