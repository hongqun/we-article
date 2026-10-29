import { writingStore } from "../../../../../lib/we-article/store";
import { articleId, draftSchema } from "../../../../../lib/we-article/validation";
import { errorResponse } from "../../../../../lib/we-article/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
// 动态路由参数遵循当前 Next.js 的异步契约。
export async function GET(_request: Request, context: Context) {
  try {
    const id = articleId.parse((await context.params).id);
    return Response.json(writingStore().read(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    const id = articleId.parse((await context.params).id);
    const draft = draftSchema.parse(await request.json());
    return Response.json(writingStore().save(id, draft));
  } catch (error) { return errorResponse(error); }
}
