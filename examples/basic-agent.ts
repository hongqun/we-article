/**
 * 一个可以单独阅读的文章解读 Agent 示例。
 *
 * 它刻意不包含 Next.js、React、项目保存和多阶段状态，只展示 Agent 的核心组成：
 * 1. 模型：负责理解和生成文字；
 * 2. 工具：在需要时读取用户给出的网页；
 * 3. 提示词：告诉 Agent 当前任务和输出格式；
 * 4. invoke：传入 user 消息，取得 assistant 回复。
 *
 * 官方文档：
 * - https://docs.langchain.com/oss/javascript/langchain/agents
 * - https://docs.langchain.com/oss/javascript/langchain/tools
 * - https://docs.langchain.com/oss/javascript/integrations/chat/deepseek
 */

import { load } from "cheerio";
import { createModel } from "../src/lib/model";
import { createAgent, tool } from "langchain";
import { z } from "zod";

// 示例与工作台共用独立配置，包含思考开关、等级和流式传输；从项目根目录运行。

// 工具就是一个普通函数，只是用 tool() 给它补充了名称、说明和参数 schema。
// Agent 会根据 description 判断什么时候需要调用它。
const readWebPage = tool(
  async ({ url }) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`网页读取失败：HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = load(html);

    // 去掉网页中对文章解读没有帮助的元素，只保留可读文字。
    $("script, style, nav, footer, noscript").remove();
    return $("article").first().text() || $("main").first().text() || $("body").text();
  },
  {
    name: "read_web_page",
    description: "读取一个 HTTP 或 HTTPS 网页，返回网页正文。",
    schema: z.object({
      url: z.string().url().describe("要读取的网页地址"),
    }),
  },
);

// Agent = 模型 + 工具 + 系统提示词。
// createAgent 会在模型需要工具时自动执行工具，再把工具结果交回模型。
async function main() {
  const agent = createAgent({
    model: await createModel(),
    tools: [readWebPage],
    systemPrompt: `你是一个文章材料解读助手，使用简体中文回答。
请按以下顺序输出 Markdown：
1. 一句话概括主题
2. 核心观点及原文依据
3. 论证逻辑、隐含前提与信息缺口
4. 值得继续追问的问题和可能的写作角度

严格区分原文事实、作者观点和你的推测。不要编造原文没有提供的事实。`,
  });

  // 实际项目中，source 和 instruction 来自网页表单；示例里直接写死，便于运行和阅读。
  const source = `
    第一次取得成绩时，人会感到兴奋；但重复取得成绩后，兴奋感会逐渐消失。
    真正让人持续感到满足的，往往不是赢，而是成长。
  `;
  const instruction = `请解读下面的材料：\n${source}`;

  // messages 中的 user 是用户输入，最后一个 assistant 就是模型输出。
  const result = await agent.invoke({
    messages: [{ role: "user", content: instruction }],
  });

  console.log(result.messages.at(-1)?.text);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
