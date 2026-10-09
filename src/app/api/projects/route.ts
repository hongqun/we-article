import { z } from "zod";
import { NextResponse } from "next/server";
import { deleteProject, listProjects, readProject, saveProject } from "../../../lib/storage";
import { requireAuth } from "../../../lib/auth";

export const runtime = "nodejs";
// 一个接口承担列表、打开和保存，学习阶段不拆分多层服务。
export async function GET(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const id = new URL(request.url).searchParams.get("id");
    return NextResponse.json(id ? await readProject(id) : await listProjects());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取失败" },
      { status: 400 },
    );
  }
}
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const input = await request.json();
    // 普通保存仍接受完整项目；恢复请求额外携带版本 ID，正文复制由服务端完成。
    const restoreVersionId = z.string().uuid().optional().parse(input.restoreVersionId);
    const restoreOutlineId = z.string().uuid().optional().parse(input.restoreOutlineId);
    // 明确的方向确认操作由服务端校验标题绑定关系。
    const confirmDirection = z.boolean().optional().parse(input.confirmDirection);
    const confirmTopic = z.boolean().optional().parse(input.confirmTopic);
    const confirmOutline = z.boolean().optional().parse(input.confirmOutline);
    // 自动保存只合并版本快照频率，当前正文与真实修改证据仍每次完整保存。
    const autosave = z.boolean().optional().parse(input.autosave);
    if (autosave && (restoreVersionId || restoreOutlineId || confirmDirection || confirmTopic || confirmOutline)) throw new Error("自动保存不能同时恢复版本或确认阶段。");
    return NextResponse.json(await saveProject(input, { restoreVersionId, restoreOutlineId, confirmDirection, confirmTopic, confirmOutline, autosave }));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败" },
      { status: 400 },
    );
  }
}

// 删除正文、版本与学习证据，服务端以一个事务完成，避免部分删除。
export async function DELETE(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const id = z.string().uuid().parse(new URL(request.url).searchParams.get("id"));
    await deleteProject(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除失败" }, { status: 400 });
  }
}
