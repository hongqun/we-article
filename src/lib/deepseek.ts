import { AsyncLocalStorage } from "node:async_hooks";
import { ChatDeepSeek } from "@langchain/deepseek";

type ModelMessages = Parameters<ChatDeepSeek["_generate"]>[0];
const requestMessages = new AsyncLocalStorage<ModelMessages>();

// 当前适配器会接收 reasoning_content，却在发送消息时丢弃它。
// 保留每次调用自己的原始消息，避免并发请求互相混入思考内容。
export class ArticleDeepSeek extends ChatDeepSeek {
  override _generate(...args: Parameters<ChatDeepSeek["_generate"]>) {
    return requestMessages.run(args[0], () => super._generate(...args));
  }

  override async *_streamResponseChunks(...args: Parameters<ChatDeepSeek["_streamResponseChunks"]>) {
    const iterator = super._streamResponseChunks(...args);
    try {
      while (true) {
        const result = await requestMessages.run(args[0], () => iterator.next());
        if (result.done) return;
        yield result.value;
      }
    } finally {
      await iterator.return(undefined);
    }
  }
}

// 在发送前补回供应商字段；流式响应原样交给 LangChain 解析，不混入正文。
export const deepSeekFetch: typeof fetch = async (input, init) => {
  const messages = requestMessages.getStore();
  if (messages && typeof init?.body === "string") {
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages) && body.thinking?.type === "enabled") {
      let assistantIndex = 0;
      const assistants = messages.filter((message) => message.type === "ai");
      for (const message of body.messages) {
        if (message.role !== "assistant") continue;
        const reasoning = assistants[assistantIndex++]?.additional_kwargs.reasoning_content;
        // 旧项目没有思考记录时留空，不编造；本次工具循环完整回传实际内容。
        message.reasoning_content = typeof reasoning === "string" ? reasoning : "";
      }
      return fetch(input, { ...init, body: JSON.stringify(body) });
    }
  }
  return fetch(input, init);
};
