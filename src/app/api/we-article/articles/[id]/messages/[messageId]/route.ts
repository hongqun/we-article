import { writingStore } from "../../../../../../../lib/we-article/store";
import { articleId, messageSchema } from "../../../../../../../lib/we-article/validation";
import { errorResponse } from "../../../../../../../lib/we-article/http";

export const runtime = "nodejs";
// 消息按文章与消息 ID 定位，服务端限制只能修改助手回复。
export async function PUT(request: Request, context: { params: Promise<{ id: string; messageId: string }> }) {
  try {
    const params = await context.params;
    const id = articleId.parse(params.id), messageId = articleId.parse(params.messageId);
    const { content } = messageSchema.parse(await request.json());
    return Response.json(writingStore().updateMessage(id, messageId, content));
  } catch (error) { return errorResponse(error); }
}
