import { NextResponse } from "next/server";
import { listWritingTopics } from "../../../lib/topics";
import { requireAuth } from "../../../lib/auth";

export const runtime = "nodejs";
// 本地文件是专题事实来源；每次刷新重新读取，接口只返回展示字段。
export const dynamic = "force-dynamic";
export async function GET() {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await listWritingTopics(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "专题配置读取失败" },
      { status: 400 },
    );
  }
}
