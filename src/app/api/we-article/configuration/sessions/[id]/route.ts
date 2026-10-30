import { writingStore } from "../../../../../../lib/we-article/store";
import { errorResponse } from "../../../../../../lib/we-article/http";
import { configurationActionSchema, configurationEditSchema } from "../../../../../../lib/we-article/configuration-schema";
import { articleId } from "../../../../../../lib/we-article/validation";
import { runConfigurationAgent } from "../../../../../../lib/we-article/configuration-agent";

type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: Context) {
  try { return Response.json(writingStore().configuration.session(articleId.parse((await context.params).id)), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const id = articleId.parse((await context.params).id);
    const input = configurationEditSchema.parse(await request.json());
    return Response.json(writingStore().configuration.editSession(id, input.draft, input.accountId));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const id = articleId.parse((await context.params).id);
    const input = configurationActionSchema.parse(await request.json());
    const store = writingStore().configuration;
    if (input.action === "confirm") return Response.json(store.confirm(id, input.draft, input.accountId));
    // 用户输入与手改草稿先保存，模型失败时仍可恢复；成功才提交候选草稿。
    store.editSession(id, input.draft, input.accountId);
    const session = store.addMessage(id, "user", input.instruction);
    const result = await runConfigurationAgent(session, session.accountId ? store.account(session.accountId) : null, request.signal);
    if (request.signal.aborted) throw new Error("请求已中断");
    return Response.json(store.addMessage(id, "assistant", result.reply, result.draft));
  } catch (error) { return errorResponse(error); }
}
