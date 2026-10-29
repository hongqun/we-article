import { beginWriting } from "../../../../../../lib/we-article/writing-service";
import { articleId, chatSchema } from "../../../../../../lib/we-article/validation";
import { errorResponse } from "../../../../../../lib/we-article/http";
import type { StreamEvent } from "../../../../../../lib/we-article/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = articleId.parse((await context.params).id);
    const input = chatSchema.parse(await request.json());
    const run = beginWriting(id, input.instruction);
    const abort = new AbortController();
    let disconnected = false;
    const disconnect = () => { disconnected = true; abort.abort(); };
    request.signal.addEventListener("abort", disconnect, { once: true });
    if (request.signal.aborted) disconnect();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: StreamEvent) => {
          if (!disconnected) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const timeout = setTimeout(() => abort.abort(), 180000);
        try {
          send({ type: "accepted", article: run.article });
          const result = await run.execute(abort.signal, message => send({ type: "status", message }),
            text => send({ type: "reasoning", text }));
          send({ type: "reply", text: result.reply });
          send({ type: "done", article: result.article });
        } catch {
          send({ type: "error", message: "本次生成未完成，已保留原稿与输入。请重新打开当前文章后重试，并检查模型配置。" });
        } finally {
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", disconnect);
          if (!disconnected) controller.close();
        }
      },
      cancel() { disconnect(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform",
    } });
  } catch (error) { return errorResponse(error); }
}
