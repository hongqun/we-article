import { NextResponse } from "next/server";
import { previewSchema } from "../../../../lib/wechat/draft";
import { formatArticle } from "../../../../lib/wechat/format";
import { publishConfig } from "../../../../lib/wechat/config";
import { wechatStore } from "../../../../lib/wechat/store";
import { readProject } from "../../../../lib/storage";
import { sameOrigin, apiError } from "../../../../lib/wechat/http";
import { requireAuth } from "../../../../lib/auth";
export const runtime = "nodejs";
// 预览接受当前未保存快照，排版结果独立于正文版本。
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    sameOrigin(request);
    const input = previewSchema.parse(await request.json());
    const config = await publishConfig(input.topicId);
    if (!config) throw new Error("此专题未配置公众号。");
    const project = await readProject(input.projectId);
    if (project.topicId !== input.topicId) throw new Error("专题已变化，请重新打开项目。");
    const result = formatArticle(input.markdown, input.fallbackTitle, input.theme, input.title);
    const store = wechatStore();
    store.db.prepare("INSERT INTO wx_preferences VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET theme=excluded.theme").run(project.id, input.theme);
    return NextResponse.json({ ...result, hasDraft: Boolean(store.draft(config.AppID, project.id, input.topicId)?.media_id),
      coverConfigured: Boolean(config.defaultThumbMediaId) });
  } catch (error) { return apiError(error); }
}
export async function GET(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const id = new URL(request.url).searchParams.get("projectId") ?? "";
    await readProject(id);
    const preference = wechatStore().db.prepare("SELECT theme FROM wx_preferences WHERE project_id=?").get(id) as { theme: string } | undefined;
    return NextResponse.json({ theme: preference?.theme ?? "ink" });
  } catch (error) { return apiError(error); }
}
