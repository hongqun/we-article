import { NextResponse } from "next/server";
import { z } from "zod";
import { buildImagePrompt } from "../../../lib/image-prompt";
import { requireAuth } from "../../../lib/auth";

export const runtime = "nodejs";

// 只接收当前编辑器快照，生成结果仅供预览和复制，不保存到数据库。
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const input = z.object({ topicId: z.string(), articleMarkdown: z.string() }).parse(await request.json());
    return NextResponse.json({ prompt: await buildImagePrompt(input.topicId, input.articleMarkdown) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "配图提示词生成失败，请重试。" }, { status: 400 });
  }
}
