import { NextResponse } from "next/server";
import { finalizeArticle } from "../../../../lib/finalize";
import { requireAuth } from "../../../../lib/auth";

export const runtime = "nodejs";

// 成稿是显式操作；普通保存和自动保存都不会触发模型判断。
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    return NextResponse.json(await finalizeArticle(await request.json()));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "成稿失败，请重试。" }, { status: 400 });
  }
}
