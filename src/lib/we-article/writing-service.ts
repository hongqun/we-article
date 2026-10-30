import { runWritingAgent } from "./agent";
import { writingStore } from "./store";

// 一轮写作负责生成和提交；HTTP 层只传递状态和结果。
export function beginWriting(id: string, instruction: string) {
  const store = writingStore();
  const run = store.begin(id, instruction);
  return {
    article: run,
    async execute(signal: AbortSignal, onStatus: (message: string) => void, onReasoning: (text: string) => void) {
      // 归属由应用加载，智能体只接收配置内容，不直接访问配置数据库。
      const context = store.configuration.context(run);
      const result = await runWritingAgent(run, signal, onStatus, onReasoning, context);
      if (signal.aborted) throw new Error("请求中断");
      const article = store.finish(id, result.draft, result.reply, result.sources);
      return { article, reply: result.reply };
    },
  };
}
