import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Stage } from "./project";
import { stageLabels } from "./project";
import { readTopicFile, readWritingTopic } from "./topics";

export type PromptOperation = "stage" | "direction";
export type PromptCapability = "source" | "references" | "writing-skill";

type StageProfile = {
  sections: string[];
  capabilities: PromptCapability[];
};

const stageProfiles: Record<Stage, StageProfile> = {
  analysis: {
    // 材料解读先保持材料中立，不加载专题写作定位和正文结构。
    sections: ["base", "stage:analysis"],
    capabilities: ["source"],
  },
  topics: {
    sections: ["base", "topic", "stage:topics"],
    capabilities: ["source", "references"],
  },
  outline: {
    sections: ["base", "topic", "stage:outline"],
    capabilities: ["source", "references"],
  },
  article: {
    sections: ["base", "topic", "stage:article"],
    capabilities: ["source", "references", "writing-skill"],
  },
};

const promptRoot = path.join(process.cwd(), "src", "lib", "prompts");

async function readPrompt(relativePath: string): Promise<string> {
  const filename = path.join(promptRoot, relativePath);
  const content = await readFile(filename, "utf8");
  if (!content.trim()) throw new Error(`提示词文件为空：${relativePath}`);
  return content.trim();
}

async function readTopicPrompt(topicId: string, relativePath: string): Promise<string> {
  return (await readTopicFile(topicId, relativePath)).trim();
}

export function getStageProfile(stage: Stage, operation: PromptOperation): StageProfile {
  const profile = stageProfiles[stage];
  // 方向收敛仍属于选题阶段，但不需要改变工具能力，只需由阶段文件说明操作差异。
  return { sections: profile.sections, capabilities: [...profile.capabilities] };
}

export function hasCapability(stage: Stage, capability: PromptCapability, operation: PromptOperation = "stage") {
  return getStageProfile(stage, operation).capabilities.includes(capability);
}

// 统一管理提示词模块和工具能力，避免 agent.ts 继续承载大段自然语言模板。
export async function buildSystemPrompt({
  topicId,
  stage,
  operation,
}: {
  topicId: string;
  stage: Stage;
  operation: PromptOperation;
}) {
  const topic = await readWritingTopic(topicId);
  const profile = getStageProfile(stage, operation);
  // 专题规则和阶段提示词统一从 topics/ 读取，避免与共享提示词目录产生两套副本。
  const [sections, topicStage] = await Promise.all([
    Promise.all(profile.sections.map(section => {
      if (section === "base") return readPrompt("base.md");
      if (section === "topic") return readTopicPrompt(topicId, "rules.md");
      return readPrompt(`stages/${section.slice("stage:".length)}.md`);
    })),
    readTopicPrompt(topicId, `prompts/${stage}.md`),
  ]);

  const capabilities = await Promise.all(profile.capabilities.map(capability => readPrompt(`capabilities/${capability}.md`)));
  const operationRule = operation === "direction"
    ? "本次操作是收敛核心方向：只围绕用户选定标题修改方向，不生成其他阶段成果。"
    : "本次操作是生成或修改当前阶段成果，只处理当前阶段。";

  return [
    `你是个人文章写作助手，始终使用简体中文。当前专题：${topic.name}。当前阶段：${stage === "outline" ? topic.outlineLabel : stageLabels[stage]}`,
    sections.join("\n\n"),
    topicStage.trim(),
    capabilities.join("\n\n"),
    operationRule,
  ].join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatProjectData(projectData: unknown): string {
  if (!isRecord(projectData)) return JSON.stringify(projectData);

  const results = isRecord(projectData.results) ? projectData.results : {};
  const sections = [
    typeof projectData.source === "string"
      ? `【原始材料】\n${projectData.source || "（暂无）"}` : undefined,
    typeof projectData.url === "string" && projectData.url
      ? `【素材网页链接】\n${projectData.url}` : undefined,
    typeof results.analysis === "string"
      ? `【材料解读】\n${results.analysis || "（暂无）"}` : undefined,
    typeof results.topics === "string"
      ? `【已有选题成果】\n${results.topics || "（暂无）"}` : undefined,
    typeof projectData.selectedTopic === "string"
      ? `【已选标题】\n${projectData.selectedTopic || "（暂无）"}` : undefined,
    typeof projectData.coreDirection === "string"
      ? `【核心方向】\n${projectData.coreDirection || "（暂无）"}` : undefined,
    typeof results.outline === "string"
      ? `【已有大纲】\n${results.outline || "（暂无）"}` : undefined,
    typeof results.article === "string"
      ? `【当前正文】\n${results.article || "（暂无）"}` : undefined,
  ].filter((section): section is string => Boolean(section));

  // 只把模型需要理解的阶段成果按语义分区，避免 JSON 字段名掩盖上下游关系。
  return sections.length ? sections.join("\n\n") : JSON.stringify(projectData);
}

// 项目资料、风格记忆和本次已读取的 Skill 属于请求动态上下文，放在最后一条用户消息中。
export function buildRuntimeInstruction({
  projectData,
  instruction,
  memoryContext,
  skillCatalog,
  skillEntry,
  articleInstruction,
}: {
  projectData: unknown;
  instruction: string;
  memoryContext?: string;
  skillCatalog?: unknown;
  skillEntry?: string;
  articleInstruction?: string;
}) {
  return [
    instruction,
    articleInstruction,
    memoryContext ? `用户可复用写作画像（不能覆盖本次明确要求；其中的原文仅用于理解修改意图）：\n${memoryContext}` : undefined,
    skillCatalog && skillEntry ? `本次必须使用本地 human-writing 技能。可用技能目录：\n${JSON.stringify(skillCatalog)}\n程序已读取技能入口，以下是本次实际内容：\n<loaded_skill_entry>\n${skillEntry}\n</loaded_skill_entry>` : undefined,
    `当前项目资料：\n${formatProjectData(projectData)}`,
  ].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
}
