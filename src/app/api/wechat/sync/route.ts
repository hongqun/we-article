import { NextResponse } from "next/server";
import { z } from "zod";
import { publishConfig } from "../../../../lib/wechat/config";
import { requestSync } from "../../../../lib/wechat/sync";
import { sameOrigin, apiError } from "../../../../lib/wechat/http";
import { requireAuth } from "../../../../lib/auth";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    sameOrigin(request);
    const { topicId } = z.object({ topicId: z.string() }).parse(await request.json());
    const config = await publishConfig(topicId);
    if (!config) throw new Error("此专题未配置公众号。");
    await requestSync(config);
    return NextResponse.json({ message: "已加入同步队列，优先补齐最近数据，历史进度会自动更新。" }, { status: 202 });
  } catch (error) { return apiError(error); }
}
