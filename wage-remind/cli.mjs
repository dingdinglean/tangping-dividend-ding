import { createLogger } from "./lib/pushplus.mjs";
import { run } from "./lib/run.mjs";

const logger = createLogger([process.env.PUSHPLUS_TOKEN, process.env.PUSHPLUS_SECRET_KEY]);

try {
  const result = await run({
    now: process.env.WAGE_NOW ? new Date(process.env.WAGE_NOW) : new Date(),
    event: process.env.WAGE_EVENT || "workflow_dispatch",
    schedule: process.env.WAGE_SCHEDULE || "",
    slot: process.env.WAGE_SLOT || "",
    force: process.env.WAGE_FORCE === "true" || process.env.WAGE_FORCE === "1",
    dryRun: process.env.WAGE_DRY_RUN === "1",
    token: process.env.PUSHPLUS_TOKEN || "",
    channel: process.env.PUSHPLUS_CHANNEL || "",
    secretKey: process.env.PUSHPLUS_SECRET_KEY || "",
    statePath: process.env.WAGE_STATE_PATH || undefined,
    logger,
  });
  console.log(`wage-remind action=${result.action} slot=${result.slot} date=${result.date}${result.reason ? ` reason=${result.reason}` : ""}`);
} catch (error) {
  console.error(`wage-remind action=failed reason=${logger.redact(error?.message || "unknown")}`);
  process.exitCode = 1;
}
