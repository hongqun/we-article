import { NextResponse } from "next/server";
import { z } from "zod";
import { readProject, retryMemoryOutboxes } from "../../../lib/storage";
import { memoryStore } from "../../../lib/style-memory/store";
import { readWritingTopic } from "../../../lib/topics";
import { refreshStyleMemory } from "../../../lib/style-memory/service";
import { manualEditSessions } from "../../../lib/style-memory/effects";
import { requireAuth } from "../../../lib/auth";

export const runtime = "nodejs";
// 专题 ID 显式限制；所有读写都使用该专题自己的 SQLite 作用域。
const topicSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export async function GET(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const url = new URL(request.url);
    const topicId = topicSchema.parse(url.searchParams.get("topicId"));
    const topic = await readWritingTopic(topicId);
    if (!topic.styleMemory) throw new Error("当前专题没有启用风格记忆。");
    await retryMemoryOutboxes();
    const store = memoryStore(topicId);
    const ids = url.searchParams.getAll("eventId").map(id => z.string().uuid().parse(id));
    const projectId = z.string().uuid().optional().parse(url.searchParams.get("projectId") ?? undefined);
    if (ids.length > 50) throw new Error("每次最多查看 50 条证据。");
    if (ids.length && projectId) throw new Error("不能同时按证据和项目读取。");
    if (ids.length) return NextResponse.json({ events: store.events(ids) });
    if (projectId) {
      const project = await readProject(projectId);
      if (project.topicId !== topicId) throw new Error("项目与专题不匹配。");
      // 服务端按写作动作边界合并，编辑页无需读取模型或其他阶段的原始事件。
      return NextResponse.json({ sessions: manualEditSessions(store.projectEvents(projectId)).reverse() });
    }
    return NextResponse.json(store.view());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取风格记忆失败" }, { status: 400 });
  }
}
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const input = z.object({ topicId: topicSchema,
      action: z.enum(["summarize", "correct", "disable", "restore"]),
      id: z.string().uuid().optional(), text: z.string().trim().min(1).max(240).optional(),
    }).parse(await request.json());
    const topic = await readWritingTopic(input.topicId);
    if (!topic.styleMemory) throw new Error("当前专题没有启用风格记忆。");
    await retryMemoryOutboxes();
    if (input.action === "summarize") {
      const result = await refreshStyleMemory(input.topicId, "manual");
      return NextResponse.json({ ...result, view: memoryStore(input.topicId).view() });
    }
    if (!input.id) throw new Error("请选择要修改的倾向。");
    memoryStore(input.topicId).manage(input.id, input.action, input.text);
    return NextResponse.json({ ok: true, message: "风格记忆已更新。", view: memoryStore(input.topicId).view() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新风格记忆失败" }, { status: 400 });
  }
}
