import { NextResponse } from "next/server";
import { DraftConflict } from "./draft";
// 本地工作台的写接口拒绝跨站浏览器请求，避免其他网页借用公众号凭证。
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const requestOrigins = new Set([requestUrl.origin]);
  const localOrigins = new Set(["http://localhost:3200", "http://127.0.0.1:3200"]);
  // 绑定 0.0.0.0 时，框架内部 URL 可能不是浏览器地址；Host 才是当前入口的实际主机。
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProto || requestUrl.protocol.replace(":", "");
    try { requestOrigins.add(new URL(`${protocol}://${host}`).origin); } catch { /* 非法 Host 不改变默认拒绝策略。 */ }
  }
  const isLocalAlias = Boolean(origin && localOrigins.has(origin) && [...requestOrigins].some(value => localOrigins.has(value)));
  // localhost 与 127.0.0.1 是本地工作台的两个合法访问入口，不能误判为跨站。
  if ((origin && !requestOrigins.has(origin) && !isLocalAlias) ||
      (request.headers.get("sec-fetch-site") === "cross-site" && !isLocalAlias))
    throw new Error("不允许跨站调用公众号操作。");
}
export function apiError(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "公众号操作失败",
    reason: error instanceof DraftConflict ? error.reason : undefined }, { status: error instanceof DraftConflict ? 409 : 400 });
}
