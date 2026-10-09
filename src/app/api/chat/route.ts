import { NextResponse } from "next/server";
import { z } from "zod";
import { projectSchema, canWriteArticle, hasConfirmedDirection } from "../../../lib/project";
import { runAgent } from "../../../lib/agent";
import { saveProject, retryMemoryOutboxes } from "../../../lib/storage";
import { isWritingTopic } from "../../../lib/topic-policy";
import { readWritingTopic } from "../../../lib/topics";
import { requireAuth } from "../../../lib/auth";

export const runtime = "nodejs";
// 输入 → 保存用户编辑 → 智能体调用 → 保存成果；异常直接反馈，不自动重试。
export async function POST(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  let project: z.infer<typeof projectSchema>;
  let instruction: string;
  let operation: "stage" | "direction";
  let instructionSource: "user" | "button";
  let regenerateFromOutline: boolean;
  let regenerateCandidates: boolean;
  let regenerateOutline: boolean;
  let styleMemoryEnabled = false;
  const feedbackId = crypto.randomUUID();
  try {
    ({ project, instruction, operation, instructionSource, regenerateFromOutline, regenerateCandidates, regenerateOutline } = z
      .object({
        project: projectSchema,
        instruction: z.string().trim().min(1).max(10000),
        operation: z.enum(["stage", "direction"]).default("stage"),
        // 旧客户端未标记来源时保守按按钮处理，避免将默认提示学习成用户偏好。
        instructionSource: z.enum(["user", "button"]).default("button"),
        // 第四步重建全文时，服务端明确区分它与基于当前正文的局部改写。
        regenerateFromOutline: z.boolean().default(false),
        // 选题候选重新生成不续接历史选题对话，避免旧方向污染新的探索。
        regenerateCandidates: z.boolean().default(false),
        // 第三步重新生成大纲时不续接历史大纲对话，避免旧思路污染新的结构。
        regenerateOutline: z.boolean().default(false),
      })
      .parse(await request.json()));
    if (regenerateFromOutline && (project.stage !== "article" || operation !== "stage"))
      throw new Error("只有正文阶段可以按当前大纲重写。");
    if (regenerateOutline && (project.stage !== "outline" || operation !== "stage"))
      throw new Error("只有大纲阶段可以重新生成写作思路。");
    // 直接调用接口也必须使用现有写作专题。
    const topic = await readWritingTopic(project.topicId);
    styleMemoryEnabled = topic.styleMemory;
    if (!isWritingTopic(project.topicId)) throw new Error("专题 ID 格式无效。");
    // 方向操作只在选题阶段使用，避免覆盖其他成果。
    if (operation === "direction" && (!isWritingTopic(project.topicId) || project.stage !== "topics" || !project.selectedTopic.trim()))
      throw new Error("请在选题阶段填写选定标题，再调整核心方向。");
    if (!project.source.trim() && !project.url)
      throw new Error("请先输入材料或话题，或提供网页链接。");
    if (project.stage !== "analysis" && !project.results.analysis.trim())
      throw new Error("请先完成材料解读。");
    if ((project.stage === "outline" || project.stage === "article") && !project.selectedTopic.trim())
      throw new Error("请先确认一个选题。");
    if (project.topicReviewPending && (project.stage === "outline" || project.stage === "article"))
      throw new Error("专题已切换，请先在第二步复核并确认题目。");
    if (project.stage === "article" && !canWriteArticle(project))
      throw new Error("请先完成并确认写作大纲，再生成或改写正文。");
    // 调用前留存手动编辑，失败后也可以重新打开或恢复。
    // 请求失败保留原确认状态；方向生成成功后由 Agent 取消确认。
    project = await saveProject(project, {
      feedback: { id: feedbackId, instruction, source: instructionSource, operation } });
    if ((project.stage === "outline" || project.stage === "article") && !hasConfirmedDirection(project))
      throw new Error("请回到第二步，根据当前标题调整并确认核心方向。");
    // 服务端保存也会取消跨专题的大纲确认，防止直接请求绕过页面复核流程。
    if (project.stage === "article" && !canWriteArticle(project))
      throw new Error("专题已切换，请先按新专题复核选题并重新确认大纲或三段思路。");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败，请重试" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  // 浏览器断开后停止向已关闭的流写入；已完成的持久化仍可重新打开查看。
  let disconnected = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => {
        if (!disconnected) controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      };
      try {
        // Agent 完成后再次保存，确保流式预览结束时成果已经持久化。
        send({ type: "saved", project });
        if (regenerateFromOutline) send({ type: "status", message: "正在按当前大纲重写正文…" });
        const hadArticle = Boolean(project.results.article.trim());
        let memory: import("../../../lib/style-memory/types").MemoryUsage | undefined;
        // 第三步重新生成必须从当前材料和已确认方向重新开始，不注入正文修改形成的风格参考。
        if (styleMemoryEnabled && !regenerateOutline) {
          // 学习失败不阻塞正文；先补转存，再按自然日整理，最后读取可用画像。
          try {
            await retryMemoryOutboxes();
            const { refreshStyleMemory, selectStyleContext } = await import("../../../lib/style-memory/service");
            await refreshStyleMemory(project.topicId, "auto", message => send({ type: "status", message }));
            memory = await selectStyleContext(project, operation, instruction);
          } catch {
            send({ type: "status", message: "风格记忆暂不可用，本次按现有专题规则继续写作。" });
          }
        }
        // 在模型调用前持久化实际使用的画像；即使生成失败也能追溯本次上下文。
        if (memory) project = await saveProject(project, { usage: memory, usageRelatedId: feedbackId, usageOperation: operation });
        const result = await runAgent(project, instruction, send, operation, memory, regenerateFromOutline, regenerateCandidates, regenerateOutline);
        const saved = await saveProject(result, {
          ...(project.stage === "article" ? { source: hadArticle ? "rewrite" as const : "generation" as const,
            summary: regenerateFromOutline ? "按当前大纲重新生成正文" : instruction } : {}),
          generated: { operation, relatedId: feedbackId, regenerateFromOutline },
        });
        send({ type: "done", project: saved });
        if (!disconnected) controller.close();
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "生成失败，请重试",
        });
        if (!disconnected) controller.close();
      }
    },
    cancel() {
      disconnected = true;
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}
