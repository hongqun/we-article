import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { ArticleDeepSeek, deepSeekFetch } from "./deepseek";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";

export type ArticleSettings = Record<string, string>;

async function readSettings(): Promise<ArticleSettings> {
  try {
    return parse(await readFile(path.resolve(process.cwd(), ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "请复制 .env.example 为 .env，并填写 DeepSeek API Key。",
      );
    throw error;
  }
}

// LangSmith 使用显式客户端，避免破坏文章项目不污染全局环境变量的隔离约束。
export async function createLangSmithTracer() {
  const settings = await readSettings();
  if (settings.LANGSMITH_TRACING?.trim().toLowerCase() !== "true")
    return undefined;
  const apiKey = settings.LANGSMITH_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new LangChainTracer({
    client: new Client({
      apiKey,
      apiUrl:
        settings.LANGSMITH_ENDPOINT?.trim() ||
        "https://api.smith.langchain.com",
    }),
    projectName: settings.LANGSMITH_PROJECT?.trim() || "article",
  });
}

// 文章项目只解析自己的 .env，不读取根配置，也不改写进程环境变量。
// https://docs.langchain.com/oss/javascript/integrations/chat/deepseek
export async function createModel() {
  const settings = await readSettings();
  const apiKey = settings.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("请在 .env 中配置 DEEPSEEK_API_KEY。");
  // 显式控制思考模式，避免依赖供应商默认值；medium 按 DeepSeek 规则映射为 high。
  // https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/
  const thinking = settings.ARTICLE_THINKING_ENABLED?.trim().toLowerCase() || "true";
  const streaming = settings.ARTICLE_STREAMING?.trim().toLowerCase() || "true";
  const effort = settings.ARTICLE_REASONING_EFFORT?.trim().toLowerCase() || "medium";
  if (!["true", "false"].includes(thinking))
    throw new Error("ARTICLE_THINKING_ENABLED 仅支持 true 或 false。");
  if (!["true", "false"].includes(streaming))
    throw new Error("ARTICLE_STREAMING 仅支持 true 或 false。");
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
    throw new Error("ARTICLE_REASONING_EFFORT 请填写 minimal、low、medium、high、xhigh、max 或 ultra。");
  return new ArticleDeepSeek({
    apiKey,
    model: settings.ARTICLE_MODEL?.trim() || "deepseek-chat",
    // 模型传输使用 stream；页面是否逐字显示由各阶段的展示规则决定。
    streaming: streaming === "true",
    disableStreaming: streaming === "false",
    // LangSmith 的 chat 类型不代表关闭思考；单独记录实际请求配置。
    metadata: {
      articleThinkingEnabled: thinking === "true",
      articleReasoningEffort: thinking === "true" ? effort : "disabled",
      articleStreaming: streaming === "true",
    },
    // modelKwargs 作为 Chat Completions 请求顶层参数发送，关闭时不传思考等级。
    modelKwargs: {
      thinking: { type: thinking === "true" ? "enabled" : "disabled" },
      ...(thinking === "true" ? { reasoning_effort: effort } : {}),
    },
    configuration: {
      baseURL: settings.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
      fetch: deepSeekFetch,
    },
    maxRetries: 0,
    timeout: 120000,
  });
}
