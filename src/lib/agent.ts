import { createAgent } from "langchain";
import { createLangSmithTracer, createModel } from "./model";
import { articleHeading, type Project, stageLabels } from "./project";
import { readWritingTopic } from "./topics";
import { createSkillAccess } from "./skills";
import humanWritingSource from "../../.agents/skills/human-writing/SOURCE.json";
import { buildAgentContext, buildCurrentInstruction, type AgentOperation } from "./agent-context";
import type { MemoryUsage } from "./style-memory/types";
import { buildAgentTools } from "./agent-tools";
import { buildRuntimeInstruction, buildSystemPrompt } from "./prompt-builder";

// 素材网页与库内参考正文都作为资料读取，不能改变 Agent 的职责。
// https://docs.langchain.com/oss/javascript/langchain/tools
export type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "saved" | "done"; project: Project };

type AgentStreamListener = (event: AgentStreamEvent) => void;

// 根运行名称优先使用成文标题，方便在 LangSmith 中按“文章 + 阶段”定位请求。
export function agentRunName(
  project: Pick<Project, "results" | "selectedTopic" | "stage">,
  outlineLabel: string,
) {
  const title = articleHeading(project.results.article) || project.selectedTopic.trim();
  const stage = project.stage === "outline" ? outlineLabel : stageLabels[project.stage];
  return title ? `《${title}》 · ${stage}` : stage;
}

export async function runAgent(
  project: Project,
  instruction: string,
  onEvent?: AgentStreamListener,
  operation: AgentOperation = "stage",
  memory?: MemoryUsage,
  regenerateFromOutline = false,
  regenerateCandidates = false,
  regenerateOutline = false,
) {
  const topic = await readWritingTopic(project.topicId);
  // 正文统一使用最新编辑稿，两套专题的其他阶段按任务裁剪上下文。
  const context = buildAgentContext(project, operation, regenerateFromOutline, regenerateCandidates, regenerateOutline);
  // 专题配置选择本地技能；只有正文阶段才加载它。
  const skillName = project.stage === "article" && operation === "stage" ? topic.writingSkill : undefined;
  const skills = skillName ? await createSkillAccess([skillName]) : undefined;
  // 阶段策略同时决定提示词能力和实际工具，避免两者出现漂移。
  const agentCapabilities = buildAgentTools({
    project, stage: project.stage, operation, skills,
    onStatus: message => onEvent?.({ type: "status", message }),
  });
  // 入口预读和模型调用共用追踪配置，不修改全局环境变量。
  const tracer = await createLangSmithTracer();
  const runConfig = {
    recursionLimit: 32,
    callbacks: tracer ? [tracer] : undefined,
    runName: agentRunName(project, topic.outlineLabel),
    tags: skills ? ["article", `skill:${skillName}`] : ["article"],
    metadata: {
      topic: project.topicId, stage: project.stage, operation, regenerateFromOutline, regenerateCandidates, regenerateOutline,
      ...(memory ? { styleVersionId: memory.versionId, styleTrendIds: memory.trendIds, styleExampleIds: memory.exampleIds } : {}),
      ...(skills ? { skill: skillName, skillVersion: humanWritingSource.version, skillCommit: humanWritingSource.commit } : {}),
    },
  };
  let skillEntry = "";
  if (skills) {
    // 必需前置步骤不依赖模型选择工具；沿用同一读取工具和路径校验，失败时尚未调用模型。
    onEvent?.({ type: "status", message: "正在读取本地写作技能入口…" });
    const entry = await skills.tool.invoke({ file: `${skillName}/SKILL.md` }, runConfig);
    skills.assertActivated();
    skillEntry = JSON.stringify(entry);
    onEvent?.({ type: "status", message: "写作技能入口已加载，正在整理正文…" });
  }
  // createAgent 自己完成“模型 → 工具 → 模型”的循环；业务阶段由用户选择。
  // https://docs.langchain.com/oss/javascript/langchain/agents
  const systemPrompt = await buildSystemPrompt({ topicId: project.topicId, stage: project.stage, operation });
  const agent = createAgent({
    model: await createModel(),
    tools: agentCapabilities.tools,
    systemPrompt,
  });
  // 显式传入筛选后的历史，不改动磁盘中的完整聊天记录。
  const input = {
    messages: [
      ...context.messages.map(({ role, content, reasoningContent }) => ({
        role, content,
        // DeepSeek 携带 tools 时需要历史思考字段，不能仅回传可见正文。
        ...(role === "assistant" && reasoningContent !== undefined
          ? { additional_kwargs: { reasoning_content: reasoningContent } } : {}),
      })),
      { role: "user" as const, content: buildRuntimeInstruction({
        projectData: context.data,
        instruction: buildCurrentInstruction(project, instruction, regenerateFromOutline),
        memoryContext: memory?.context,
        skillCatalog: skills?.catalog,
        skillEntry,
        articleInstruction: project.stage === "article"
          ? regenerateFromOutline
            ? "这是按当前大纲重新写作的操作：按当前 results.outline 从头组织正文，旧正文不参与本次生成。"
            : "这是正文写作或改写：以当前正文和本次要求为准，大纲不得覆盖用户已经调整的表达。"
          : undefined,
      }) },
    ],
  };
  let answer = "";
  let reasoningContent: string | undefined;
  if (onEvent) {
    // 各阶段只播报进度，最终从根运行取成果，避免工具说明和失败提示进入编辑区。
    let rootRunId: string | undefined;
    let reasoningRoundStarted = false;
    let hasReasoning = false;
    const events = await agent.streamEvents(input, {
      ...runConfig,
      version: "v2",
    });
    for await (const event of events) {
      if (!rootRunId && event.event === "on_chain_start") rootRunId = event.run_id;
      if (event.event === "on_chat_model_start") reasoningRoundStarted = false;
      // 思考增量独立发送；工具前后多轮思考分段显示，不进入正文 token 流。
      if (event.event === "on_chat_model_stream") {
        const reasoning = event.data.chunk?.additional_kwargs?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          onEvent({ type: "reasoning", text: `${!reasoningRoundStarted && hasReasoning ? "\n\n" : ""}${reasoning}` });
          reasoningRoundStarted = true;
          hasReasoning = true;
        }
      }
      if (event.event === "on_tool_start") {
        if (!["search_articles", "read_article"].includes(event.name))
          onEvent({ type: "status", message: event.name === "read_skill_file" ? `正在读取写作技能：${event.data.input?.file ?? "本地文件"}…` : `正在${event.name}…` });
      } else if (event.event === "on_tool_end") {
        if (!["search_articles", "read_article"].includes(event.name))
          onEvent({ type: "status", message: event.name === "read_skill_file" ? "技能文件已读取，正在写作与自查…" : `${event.name}已完成` });
      } else if (event.event === "on_chain_end" && event.run_id === rootRunId) {
        // 最终消息是唯一保存来源，同时支持开启或关闭模型流式传输。
        const finalMessage = event.data.output?.messages?.at(-1);
        answer = finalMessage?.text ?? "";
        reasoningContent = finalMessage?.additional_kwargs?.reasoning_content;
      }
    }
  } else {
    const result = await agent.invoke(input, runConfig);
    answer = result.messages.at(-1)?.text ?? "";
    const reasoning = result.messages.at(-1)?.additional_kwargs.reasoning_content;
    reasoningContent = typeof reasoning === "string" ? reasoning : undefined;
  }
  return applyAgentResult(project, instruction, answer, operation, () => {
    skills?.assertActivated();
    agentCapabilities.assertReady();
  }, reasoningContent);
}

// 将校验与成果更新收在同一入口，工具失败后即使模型返回文字也不能覆盖原稿。
export function applyAgentResult(project: Project, instruction: string, answer: string,
  operation: AgentOperation, assertReady: () => void, reasoningContent?: string): Project {
  assertReady();
  // 链接未读成功时不把模型的猜测存成解读成果。
  if (project.url && !project.source.trim())
    throw new Error("未能读取网页正文，请粘贴材料后重试。");
  if (!answer?.trim()) throw new Error("模型没有返回内容，请重试。");
  // 收敛方向不覆盖候选列表，便于用户回看最初选题。
  if (operation === "direction") {
    project.coreDirection = answer;
    project.directionTopic = project.selectedTopic;
    project.directionConfirmed = false;
  } else {
    project.results[project.stage] = answer;
  }
  // 正文迭代保留上游成果；人工确认与系统准备状态分别维护。
  if (project.stage !== "article") project.outlineConfirmed = false;
  project.messages.push(
    { role: "user", content: instruction, stage: project.stage, topicId: project.topicId, operation },
    { role: "assistant", content: answer, stage: project.stage, topicId: project.topicId, operation,
      ...(typeof reasoningContent === "string" ? { reasoningContent } : {}) },
  );
  // 完成事件由接口在持久化成功后发送，Agent 只负责返回成果。
  return project;
}
