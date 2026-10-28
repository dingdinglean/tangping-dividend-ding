const PUSH_URL = "https://api.day.app/push";

/**
 * Bark 官方推送（bark-server API V2，POST https://api.day.app/push）。
 * device_key 只放在 JSON 正文里，不放进 URL，避免密钥出现在访问日志里。
 *
 * 成功标准来自 bark-server router.go 的 success()：HTTP 200，且
 * {"code":200,"message":"success","timestamp":<unix>}。
 * 只认这两个条件同时成立。code 为 0 或其他值都不是成功。
 *
 * 4xx（密钥无效等）不重试。网络错误、无法解析的响应、HTTP 429/5xx
 * 按 1 秒、2 秒退避，最多共 3 次。Bark 文档写明短时间大量错误请求会封 IP，
 * 所以客户端错误绝不重试。
 *
 * level 固定 active，sound 用内置 bell。不传 call，也不用 critical / timeSensitive。
 */
export const BARK_GROUP = "打工自由助手";
export const BARK_LEVEL = "active";
export const BARK_SOUND = "bell";
export const DEFAULT_MAX_ATTEMPTS = 3;

const ICON_REV = "d087b6fc9203aa864a1c1605a04e03befdb1593d";
const ICON_BASE = `https://cdn.jsdelivr.net/gh/dingdinglean/tangping-dividend-ding@${ICON_REV}/wage-remind/assets`;
export const BARK_ICON_MORNING = `${ICON_BASE}/morning-sun.png`;
export const BARK_ICON_EVENING = `${ICON_BASE}/evening-wallet.png`;

export function iconForSlot(slot) {
  return slot === "evening" ? BARK_ICON_EVENING : BARK_ICON_MORNING;
}

export class FatalSendError extends Error {}

export function createLogger(secrets, sink = console) {
  const list = [...secrets].filter((secret) => typeof secret === "string" && secret.length >= 4)
    .sort((left, right) => right.length - left.length);
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

export function assertDeviceKey(deviceKey) {
  if (!deviceKey) throw new FatalSendError("缺少 BARK_DEVICE_KEY");
  const key = String(deviceKey);
  if (key !== key.trim() || /\s/.test(key) || key.includes("/") || key.includes("?") || key.includes("#")) {
    throw new FatalSendError("BARK_DEVICE_KEY 无效");
  }
}

async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`推送服务返回了无法解析的响应（HTTP ${response.status}）`);
  }
}

function isSuccess(response, payload) {
  return response.status === 200 && payload?.code === 200;
}

function isTransient(status, code) {
  if (status === 429 || status >= 500) return true;
  return code === 429 || (typeof code === "number" && code >= 500);
}

export function barkPayload({ deviceKey, title, body, icon }) {
  const payload = {
    device_key: String(deviceKey),
    title: String(title || "").replace(/[\r\n]/g, "").trim(),
    body: String(body || "").replace(/\r\n/g, "\n").trim(),
    group: BARK_GROUP,
    level: BARK_LEVEL,
    sound: BARK_SOUND,
  };
  if (icon) {
    if (!/^https:\/\/\S+$/.test(icon)) throw new FatalSendError("Bark 图标地址无效");
    payload.icon = icon;
  }
  return payload;
}

export async function deliverMessage({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deviceKey,
  title,
  body,
  icon,
  logger,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  assertDeviceKey(deviceKey);
  const log = logger || createLogger([deviceKey]);
  const payload = barkPayload({ deviceKey, title, body, icon });
  if (!payload.title || !payload.body) throw new FatalSendError("Bark 标题或正文为空");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
      const data = await readBody(response);
      if (isSuccess(response, data)) {
        log.info(`bark accepted code=200 attempt=${attempt}`);
        return { code: 200, resent: attempt > 1 };
      }
      const reason = safeReason(data?.message || "", log.redact);
      log.error(`bark rejected http=${response.status} code=${data?.code ?? ""} attempt=${attempt} reason=${reason}`);
      if (!isTransient(response.status, data?.code)) throw new FatalSendError("Bark 拒绝了这条推送");
    } catch (error) {
      if (error instanceof FatalSendError) throw error;
      log.error(`bark transport attempt=${attempt}`);
    }
    if (attempt < maxAttempts) await sleep(attempt * 1000);
  }
  throw new Error("Bark 请求失败");
}
