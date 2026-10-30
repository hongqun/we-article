import { runWritingAgent } from "./agent";
import { writingStore } from "./store";

// 一轮写作负责生成和提交；HTTP 层只传递状态和结果。
export function beginWriting(id: string, instruction: string) {
  const store = writingStore();
  const run = store.begin(id, instruction);
  return {
    article: run,
    async execute(signal: AbortSignal, onStatus: (message: string) => void, onReasoning: (text: string) => void) {
      const result = await runWritingAgent(run, signal, onStatus, onReasoning);
      if (signal.aborted) throw new Error("请求中断");
      const article = store.finish(id, result.draft, result.reply, result.sources);
      return { article, reply: result.reply };
    },
  };
}
