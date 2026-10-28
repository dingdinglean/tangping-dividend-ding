const SEND_HOST = "https://sctapi.ftqq.com";

/**
 * Server酱 Turbo 免费会员（官方文档 2026-07-28，sct.ftqq.com/docs）：
 * 注册即为免费会员，每天最多 5 条；不使用订阅会员的 1000 条额度，也不调用付费接口。
 * 本提醒每个工作日最多早上、晚上各 1 条，合计 2 条，留出手动测试的余量。
 * 失败重试最多再请求 1 次，避免把每天 5 条额度打光。
 *
 * 官方成功标准是 HTTP 响应里的 JSON code === 0。没有单独的「微信客户端已展示」免费查询。
 * 若响应带 pushid 和 readkey，会再 GET /push 确认服务端留存了这条消息；
 * 查不到也不重发，因为重发会再占一条免费额度，而且可能重复通知。
 *
 * 请求只带 title 和 desp。channel 的编号在用户控制台，写死会改掉已选的微信通道。
 * openid 群发是订阅会员功能，且只用于测试号和企业微信。short 是卡片短描述，
 * 但免费会员的微信卡片只显示标题，服务号即使订阅也不展开正文。这些参数都不能
 * 让免费微信预览多看到金额，所以不传，也不据此重试。
 */
export const FREE_DAILY_LIMIT = 5;
export const TITLE_LIMIT = 32;

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

export function assertTurboSendKey(sendKey) {
  if (!sendKey) throw new FatalSendError("缺少 SERVERCHAN_SENDKEY");
  if (String(sendKey).startsWith("sctp")) {
    throw new FatalSendError("这是 Server酱³ 的 SendKey。本提醒只使用免费的 Server酱 Turbo");
  }
  if (!/^SCT[A-Za-z0-9]+$/.test(sendKey)) {
    throw new FatalSendError("SERVERCHAN_SENDKEY 须为 Server酱 Turbo 的 SCT 密钥");
  }
}

export function toDesp(content) {
  return String(content || "").replace(/\r\n/g, "\n").replace(/\n+/g, "\n\n");
}

async function readBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`推送服务返回了无法解析的响应（HTTP ${response.status}）`);
  }
}

function isFatalCode(payload) {
  const reason = `${payload?.message || ""} ${payload?.info || ""}`;
  return payload?.code === 40001 || /额度|上限|错误的Key|SendKey|无效/.test(reason);
}

async function queryStored(fetchImpl, pushid, readkey) {
  const url = new URL(`${SEND_HOST}/push`);
  url.searchParams.set("id", String(pushid));
  url.searchParams.set("readkey", String(readkey));
  const response = await fetchImpl(url, { method: "GET" });
  const payload = await readBody(response);
  if (payload?.code === 0 && payload.data && typeof payload.data === "object") return "yes";
  return "no";
}

export async function deliverMessage({
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sendKey,
  title,
  desp,
  logger,
  maxAttempts = 2,
}) {
  assertTurboSendKey(sendKey);
  const log = logger || createLogger([sendKey]);
  if ([...String(title || "")].length > TITLE_LIMIT || /[\r\n]/.test(title || "")) {
    throw new FatalSendError("通知标题超过 32 个字或含有换行");
  }
  const url = `${SEND_HOST}/${sendKey}.send`;
  let lastError = new Error("Server酱请求失败");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json;charset=utf-8" },
        body: JSON.stringify({ title, desp: toDesp(desp) }),
      });
      const payload = await readBody(response);
      if (payload?.code === 0) {
        const pushid = payload.data?.pushid || payload.data?.pushId || "";
        const readkey = payload.data?.readkey || payload.data?.readKey || "";
        let stored = "unchecked";
        if (pushid && readkey) {
          try {
            stored = await queryStored(fetchImpl, pushid, readkey);
          } catch {
            stored = "unknown";
          }
        }
        log.info(`serverchan accepted code=0 stored=${stored} attempt=${attempt}`);
        return { code: 0, stored, resent: attempt > 1 };
      }
      const transient = response.status === 429 || response.status >= 500;
      const reason = safeReason(payload?.message || payload?.info || "", log.redact);
      log.error(`serverchan rejected code=${payload?.code ?? response.status} attempt=${attempt} reason=${reason}`);
      if (!transient || isFatalCode(payload) || attempt === maxAttempts) {
        throw new FatalSendError("Server酱拒绝了这条推送");
      }
      await sleep(attempt * 1000);
    } catch (error) {
      if (error instanceof FatalSendError) throw error;
      lastError = error;
      log.error(`serverchan transport attempt=${attempt}`);
      if (attempt === maxAttempts) throw new Error("Server酱请求失败");
      await sleep(attempt * 1000);
    }
  }
  throw lastError;
}
