import type { PublishConfig } from "./config";

export class WechatError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly uncertain = false) { super(message); }
}
const state = globalThis as typeof globalThis & { wxTokens?: Map<string, { value: string; expires: number; secret: string }>;
  wxTokenFlights?: Map<string, Promise<string>> };
const tokens = state.wxTokens ??= new Map();
const flights = state.wxTokenFlights ??= new Map();
const messages: Record<number, string> = { 40001: "公众号凭证无效，请检查 AppID / AppSecret。", 40013: "公众号 AppID 无效。",
  40125: "公众号 AppSecret 无效。", 40164: "当前服务器 IP 不在公众号白名单中。", 48001: "公众号没有此接口权限，请检查账号认证与权限。",
  48004: "公众号接口被封禁，请到公众号后台检查。", 45009: "公众号接口调用已达限额，稍后重试。", 40007: "素材或草稿已失效。",
  40004: "素材类型无效。", 61501: "统计日期超出接口允许范围。", 88000: "公众号尚无留言权限。" };
async function post(url: string, payload: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try { response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(25_000), cache: "no-store" }); }
  catch { throw new WechatError("微信请求超时或网络中断，操作结果需要核对。", null, true); }
  if (!response.ok) throw new WechatError(`微信服务返回 HTTP ${response.status}，请稍后重试。`, null, true);
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new WechatError("微信响应无法解析，操作结果需要核对。", null, true); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new WechatError("微信响应格式异常，请核对远端结果。", null, true);
  const code = Number(data.errcode ?? 0);
  // 不回传原始 URL 或微信错误文本，避免凭证通过报错泄漏。
  if (code) throw new WechatError(messages[code] ?? `微信接口返回错误 ${code}，请核对账号权限与输入。`, code, code === -1);
  return data;
}
async function token(config: PublishConfig) {
  const cached = tokens.get(config.AppID);
  if (cached && cached.secret === config.AppSecret && cached.expires > Date.now()) return cached.value;
  const key = config.AppID + ":" + config.AppSecret;
  if (flights.has(key)) return flights.get(key)!;
  const flight = (async () => {
    const result = await post("https://api.weixin.qq.com/cgi-bin/stable_token", {
      grant_type: "client_credential", appid: config.AppID, secret: config.AppSecret, force_refresh: false });
    if (typeof result.access_token !== "string") throw new WechatError("微信未返回访问凭证。");
    tokens.set(config.AppID, { value: result.access_token, secret: config.AppSecret,
      expires: Date.now() + Math.max(60, Number(result.expires_in ?? 7200) - 300) * 1000 });
    return result.access_token;
  })();
  flights.set(key, flight);
  try { return await flight; } finally { flights.delete(key); }
}
// 只允许内部固定路径，失效 token 最多重新获取一次；不自动重试未知结果的写请求。
export async function wechatCall<T = Record<string, unknown>>(config: PublishConfig, path: string, payload: unknown): Promise<T> {
  if (!/^\/(cgi-bin\/draft\/(add|update|get|batchget)|datacube\/get[a-z]+)$/.test(path)) throw new Error("不支持的微信接口。");
  for (let attempt = 0; ; attempt++) {
    const access = await token(config);
    try { return await post(`https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(access)}`, payload) as T; }
    catch (error) {
      if (attempt === 0 && error instanceof WechatError && [40001, 40014, 42001].includes(error.code ?? 0)) { tokens.delete(config.AppID); continue; }
      throw error;
    }
  }
}
