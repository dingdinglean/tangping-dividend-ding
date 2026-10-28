import { createLogger } from "./lib/bark.mjs";
import { run } from "./lib/run.mjs";

const deviceKey = process.env.BARK_DEVICE_KEY || "";
const logger = createLogger([deviceKey]);

try {
  const result = await run({
    now: process.env.WAGE_NOW ? new Date(process.env.WAGE_NOW) : new Date(),
    event: process.env.WAGE_EVENT || "workflow_dispatch",
    schedule: process.env.WAGE_SCHEDULE || "",
    slot: process.env.WAGE_SLOT || "",
    force: process.env.WAGE_FORCE === "true" || process.env.WAGE_FORCE === "1",
    dryRun: process.env.WAGE_DRY_RUN === "1",
    deviceKey,
    statePath: process.env.WAGE_STATE_PATH || undefined,
    logger,
  });
  console.log(`wage-remind action=${result.action} slot=${result.slot} date=${result.date}${result.reason ? ` reason=${result.reason}` : ""}`);
} catch (error) {
  console.error(`wage-remind action=failed reason=${logger.redact(error?.message || "unknown")}`);
  process.exitCode = 1;
}
