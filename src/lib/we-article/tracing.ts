import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";

export function createWritingTracing(settings: Record<string, string>) {
  if (settings.LANGSMITH_TRACING?.trim().toLowerCase() !== "true") return undefined;
  const apiKey = settings.LANGSMITH_API_KEY?.trim();
  if (!apiKey) return undefined;
  const client = new Client({
    apiKey,
    apiUrl: settings.LANGSMITH_ENDPOINT?.trim() || "https://api.smith.langchain.com",
    workspaceId: settings.LANGSMITH_WORKSPACE_ID?.trim() || undefined,
  });
  const tracer = new LangChainTracer({
    client,
    projectName: settings.LANGSMITH_PROJECT?.trim() || "article",
  });
  // 回调先完成入队，请求结束时才能完整提交模型和工具的子运行。
  tracer.awaitHandlers = true;
  return { tracer, client };
}
