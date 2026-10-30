import { ChatOpenAI } from "@langchain/openai";
import { WritingModel } from "./deepseek-adapter";

export function createWritingModel(settings: Record<string, string>) {
  // 写作模型使用项目配置。
  const provider = settings.MODEL_PROVIDER?.trim().toLowerCase() || "openai";
  const apiKey = settings.MODEL_API_KEY?.trim();
  if (!apiKey) throw new Error("模型未配置：请填写 MODEL_API_KEY");
  if (!["openai", "deepseek"].includes(provider)) throw new Error("模型类型无效");
  const streaming = settings.STREAMING?.trim().toLowerCase() || "true";
  if (!["true", "false"].includes(streaming)) throw new Error("模型参数无效");
  const baseURL = settings.MODEL_BASE_URL?.trim() ||
    (provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1");
  const common = {
    apiKey, model: settings.MODEL?.trim() || (provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini"),
    streaming: streaming === "true", disableStreaming: streaming === "false",
    timeout: 120000, maxRetries: 0,
  };
  if (provider === "openai") {
    // 兼容接口只发送通用参数，避免强加厂商的思考字段和流式用量参数。
    return new ChatOpenAI({ ...common, streamUsage: false, useResponsesApi: false, configuration: { baseURL } });
  }
  const thinking = settings.THINKING_ENABLED?.trim().toLowerCase() || "true";
  const effort = settings.REASONING_EFFORT?.trim().toLowerCase() || "medium";
  if (!["true", "false"].includes(thinking) ||
    !["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))
    throw new Error("模型参数无效");
  return new WritingModel({
    ...common,
    metadata: {
      articleThinkingEnabled: thinking === "true",
      articleReasoningEffort: thinking === "true" ? effort : "disabled",
      articleStreaming: streaming === "true",
    },
    modelKwargs: {
      thinking: { type: thinking === "true" ? "enabled" : "disabled" },
      ...(thinking === "true" ? { reasoning_effort: effort } : {}),
    },
    configuration: { baseURL },
  });
}
