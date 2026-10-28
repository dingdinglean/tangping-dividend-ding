const SEND_URL = "https://www.pushplus.plus/send";
const CUSTOMER_RESULT_URL = "https://www.pushplus.plus/api/customer/message/sendMessageResult";
const ACCESS_KEY_URL = "https://www.pushplus.plus/api/common/openApi/getAccessKey";
const OPEN_RESULT_URL = "https://www.pushplus.plus/api/open/message/sendMessageResult";

const FATAL_CODES = new Set([401, 403, 903]);

/**
 * 渠道取舍（PushPlus 官方文档，2026-09）：
 * - wechat：微信服务号，默认通道。关注并实名绑定后由服务号下发，不要求用户每 10 条或每 24 小时回消息，适合 GitHub Actions 长期无人值守。消息在服务号会话里，不是好友气泡。
 * - clawbot：微信 ClawBot。官方限制是扫码绑定、绑定后必须主动对话、每下发 10 条必须互动、每 24 小时必须互动。不适合长期无人维护，只有显式配置 PUSHPLUS_CHANNEL=clawbot 或 config.channel 时才使用。
 * 发送接口的 HTTP 200 / code 200 只表示请求被受理并返回流水号，不表示送达。随后查询最终状态：0 未投递，1 发送中，2 已发送，3 发送失败。
 */
export const CHANNEL_NOTES = Object.freeze({
  wechat: "官方微信服务号，适合无人值守",
  clawbot: "好友式文本，但需要周期性人工互动，不作为默认",
});

export function createLogger(secrets, sink = console) {
  const list = [...secrets].filter((secret) => typeof secret === "string" && secret.length >= 4)
    .sort((a, b) => b.length - a.length);
  const redact = (value) => {
    let text = String(value ?? "");
    for (const secret of list) text = text.split(secret).join("[redacted]");
    return text;
  };
  return {
    redact,
    info(message) { sink.log(redact(message)); },
    error(message) { sink.error(redact(message)); },
  };
}

export function safeReason(message, redact) {
  return redact(String(message ?? "")).replace(/\d+/g, "#").slice(0, 160);
}

export class FatalPushError extends Error {}

function interpretStatus(payload) {
  if (!payload || typeof payload !== "object") return { type: "error" };
  if (payload.code === 302) return { type: "unauthorized" };
  if (payload.code !== 200) return { type: "error", code: payload.code };
  const status = Number(payload.data?.status);
  if (![0, 1, 2, 3].includes(status)) return { type: "error" };
  return { type: "status", status, reason: payload.data?.errorMessage || "" };
}

async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`推送服务返回了无法解析的响应（HTTP ${response.status}）`);
  }
}

function shortCodeFrom(payload) {
  if (typeof payload?.data === "string" && payload.data.trim()) return payload.data.trim();
  if (typeof payload?.data?.shortCode === "string" && payload.data.shortCode.trim()) return payload.data.shortCode.trim();
  return "";
}

async function customerStatus(fetchImpl, token, shortCode) {
  const url = new URL(CUSTOMER_RESULT_URL);
  url.searchParams.set("shortCode", shortCode);
  const response = await fetchImpl(url, { method: "GET", headers: { pushToken: token } });
  return interpretStatus(await readBody(response));
}

async function openStatus(fetchImpl, accessKey, shortCode) {
  const url = new URL(OPEN_RESULT_URL);
  url.searchParams.set("shortCode", shortCode);
  const response = await fetchImpl(url, { method: "GET", headers: { "access-key": accessKey } });
  return interpretStatus(await readBody(response));
}

async function fetchAccessKey(fetchImpl, token, secretKey) {
  const response = await fetchImpl(ACCESS_KEY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, secretKey }),
  });
  const payload = await readBody(response);
  const accessKey = payload?.code === 200 ? payload.data?.accessKey : "";
  if (!accessKey) throw new Error("无法取得推送结果查询凭证");
  return accessKey;
}

export async function deliverMessage({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  token,
  secretKey = "",
  channel,
  title,
  content,
  previousShortCode = "",
  onAccepted,
  logger = createLogger([token, secretKey]),
  maxAttempts = 3,
  pollAttempts = 8,
  pollIntervalMs = 2000,
}) {
  if (!token) throw new FatalPushError("缺少 PUSHPLUS_TOKEN");
  if (!["wechat", "clawbot"].includes(channel)) throw new FatalPushError("推送渠道只支持 wechat 或 clawbot");

  const poll = async (shortCode) => {
    let accessKey = "";
    let useOpen = false;
    for (let index = 0; index < pollAttempts; index += 1) {
      let result;
      if (!useOpen) {
        result = await customerStatus(fetchImpl, token, shortCode);
        if (result.type === "unauthorized") {
          if (!secretKey) return { type: "unconfirmed" };
          useOpen = true;
          accessKey = await fetchAccessKey(fetchImpl, token, secretKey);
          result = await openStatus(fetchImpl, accessKey, shortCode);
        }
      } else {
        result = await openStatus(fetchImpl, accessKey, shortCode);
      }
      if (result.type === "status" && (result.status === 2 || result.status === 3)) return result;
      if (index === pollAttempts - 1) {
        return result.type === "status" ? { type: "pending", status: result.status } : { type: "error" };
      }
      await sleep(pollIntervalMs);
    }
    return { type: "error" };
  };

  if (previousShortCode) {
    const existing = await poll(previousShortCode);
    if (existing.type === "status" && existing.status === 2) {
      logger.info("push reconciled status=2");
      return { status: 2, shortCode: previousShortCode, resent: false };
    }
    if (existing.type !== "status" || existing.status !== 3) {
      throw new Error("上次推送尚未确认送达，为避免重复发送已停止重发");
    }
    logger.error(`push previous failed reason=${safeReason(existing.reason, logger.redact)}`);
  }

  let lastError = new Error("推送未被确认送达");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let acceptedShortCode = "";
    try {
      const response = await fetchImpl(SEND_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, title, content, template: "txt", channel }),
      });
      const payload = await readBody(response);
      if (payload?.code !== 200) {
        const error = FATAL_CODES.has(payload?.code)
          ? new FatalPushError("推送请求被拒绝")
          : new Error("推送请求未被受理");
        if (error instanceof FatalPushError || attempt === maxAttempts) throw error;
        logger.error(`push rejected code=${payload?.code ?? "unknown"} attempt=${attempt}`);
        await sleep(attempt * 1000);
        continue;
      }
      const shortCode = shortCodeFrom(payload);
      if (!shortCode) throw new Error("推送受理成功但没有流水号");
      acceptedShortCode = shortCode;
      if (onAccepted) await onAccepted(shortCode);
      const polled = await poll(shortCode);
      if (polled.type === "status" && polled.status === 2) {
        logger.info(`push confirmed status=2 attempt=${attempt} channel=${channel}`);
        return { status: 2, shortCode, resent: true };
      }
      if (polled.type === "status" && polled.status === 3) {
        lastError = new Error("推送最终状态为失败");
        logger.error(`push delivery failed status=3 attempt=${attempt} reason=${safeReason(polled.reason, logger.redact)}`);
        if (attempt === maxAttempts) throw lastError;
        await sleep(attempt * 1000);
        continue;
      }
      logger.error(`push unconfirmed attempt=${attempt}`);
      throw new Error("推送未被确认送达");
    } catch (error) {
      if (error instanceof FatalPushError) throw error;
      if (acceptedShortCode) throw new Error("推送未被确认送达");
      lastError = error;
      if (attempt === maxAttempts) throw error;
      await sleep(attempt * 1000);
    }
  }
  throw lastError;
}
