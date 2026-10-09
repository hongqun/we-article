import { z } from "zod";
import { memoryEventSchema } from "./style-memory/types";
import { isWritingTopic } from "./topic-policy";
import { createUuid } from "./uuid";

// 前后端共用最小数据结构；持久化由统一 SQLite 保存项目和独立版本记录。
export const stages = ["analysis", "topics", "outline", "article"] as const;
export type Stage = (typeof stages)[number];
export const stageLabels: Record<Stage, string> = {
  analysis: "材料解读",
  topics: "文章选题",
  outline: "写作大纲",
  article: "文章正文",
};
// 版本元数据由服务端创建；旧项目缺失字段时自动补齐，不改写历史成果。
export const articleVersionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  content: z.string(),
  source: z.enum(["generation", "rewrite", "manual", "restore"]),
  summary: z.string().max(200),
  // 标记自动快照以控制频率；不修改既有版本，旧数据缺省按普通版本处理。
  autosaved: z.boolean().optional(),
  // 生成版本绑定实际模型请求，效果统计不使用其他请求的记忆快照。
  requestId: z.string().uuid().optional(),
  topicId: z.string().optional(),
});
export type ArticleVersion = z.infer<typeof articleVersionSchema>;
// 成稿快照用于比较每篇文章的修改过程；系统修订大纲不冒充人工确认。
export const finalizationSchema = z.object({
  id: z.string().uuid(), articleVersionId: z.string().uuid(), createdAt: z.string(),
  topicId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  status: z.enum(["pending", "completed", "failed"]),
  originalOutline: z.string(), revisedOutline: z.string().nullable(),
  structuralChange: z.boolean().nullable(), reason: z.string(),
  feedbackCount: z.number().int().nonnegative(), manualEdited: z.boolean(), styleUsed: z.boolean(),
});
export type Finalization = z.infer<typeof finalizationSchema>;
export const articleVersionLabels: Record<ArticleVersion["source"], string> = {
  generation: "生成", rewrite: "改写", manual: "手动保存", restore: "恢复",
};
export const projectSchema = z.object({
  id: z.string().uuid(),
  // 每个项目必须明确归属专题；缺少专题 ID 的旧通用项目已清理。
  topicId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1).max(120),
  source: z.string().max(100000),
  url: z.union([z.literal(""), z.url()]),
  stage: z.enum(stages),
  results: z.object({
    analysis: z.string(),
    topics: z.string(),
    outline: z.string(),
    article: z.string().default(""),
  }),
  // 大纲变更后标记正文需要按新结构重写；成功生成正文后由服务端清除。
  articleNeedsRegeneration: z.boolean().default(false),
  articleVersions: z.array(articleVersionSchema).default([]),
  finalizations: z.array(finalizationSchema).default([]),
  selectedTopic: z.string(),
  // 核心方向独立于候选列表；旧项目不会自动视为已确认。
  coreDirection: z.string().default(""),
  directionTopic: z.string().default(""),
  directionConfirmed: z.boolean().default(false),
  outlineConfirmed: z.boolean(),
  // 切换专题后要求重新确认当前题目；旧项目默认已经完成原有选择。
  topicReviewPending: z.boolean().default(false),
  // 记录大纲依据以识别上游变化；模型生成本身不等于人工确认。
  outlineBasis: z.string().default(""),
  // 转存待办由服务端维护，旧项目按空列表读取；客户端不能覆盖数据库待办。
  memoryOutbox: z.array(memoryEventSchema).default([]),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      // 思考内容用于下次模型请求，独立保存，不作为聊天正文展示；兼容旧项目。
      reasoningContent: z.string().optional(),
      stage: z.enum(stages),
      // 新消息记录所属专题和操作，供上下文筛选；旧项目不补猜测值。
      topicId: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
      operation: z.enum(["stage", "direction"]).optional(),
    }),
  ),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;
// 列表只传递筛选和展示所需字段，不把材料、正文或提示词送到浏览器。
export type ProjectSummary = Pick<Project, "id" | "topicId" | "title" | "updatedAt">;
// 浏览器只需要专题展示信息，不接收提示词和参考全文。
export type WritingTopicSummary = {
  id: string;
  name: string;
  description: string;
  outlineLabel: string;
  workflow?: "auto-after-topic" | "staged";
  directionLabel?: string;
  isDefault?: boolean;
  directionLength?: { min: number; max: number };
  styleMemory?: boolean;
  imagePrompt?: boolean;
  // 只公开发布能力状态，公众号密钥永不发送到浏览器。
  publish?: { enabled: boolean; coverConfigured: boolean; error?: string };
};

// 只有产生材料、阶段成果或讨论记录的项目才允许进入持久化层。
export function hasProjectContent(project: Pick<Project, "source" | "url" | "results" | "selectedTopic" | "coreDirection" | "articleVersions" | "messages">): boolean {
  return Boolean(project.source.trim() || project.url.trim() ||
    Object.values(project.results).some(value => value.trim()) ||
    project.selectedTopic.trim() || project.coreDirection.trim() ||
    project.articleVersions.length || project.messages.length);
}

function hasStageContent(project: Project, stage: Stage): boolean {
  if (stage === "topics") return Boolean(project.results.topics.trim() || project.selectedTopic.trim() || project.coreDirection.trim());
  return Boolean(project.results[stage].trim());
}

// 打开旧项目时只在内存中回退到最近的有内容阶段，避免空白编辑区；不改写数据库阶段。
export function stageForViewing(project: Project): Stage {
  if (hasStageContent(project, project.stage)) return project.stage;
  return [...stages].reverse().find(stage => hasStageContent(project, stage)) ?? project.stage;
}

function formatProjectTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 正文首行一级标题是成文后的标题；没有正文标题时沿用选题标题。
export function articleHeading(markdown: string): string {
  const firstLine = markdown.split(/\r?\n/).find(line => line.trim());
  const heading = firstLine?.match(/^\s*#\s+(.+?)\s*#*\s*$/)?.[1];
  return heading ? heading.trim().slice(0, 120) : "";
}

// 列表和只读搜索共用显示名称；仅需标题相关字段，无需加载完整聊天和版本。
// 保留默认名称里的创建时间，旧自定义名称则取最近保存时间。
export function toProjectSummary(project: Pick<Project, "id" | "topicId" | "title" | "updatedAt" | "selectedTopic"> &
  { results: Pick<Project["results"], "article"> }): ProjectSummary {
  const topic = articleHeading(project.results.article) || project.selectedTopic.trim();
  const timestamp = project.title.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?=_|$)/)?.[0]
    ?? formatProjectTimestamp(new Date(project.updatedAt));
  return { id: project.id, topicId: project.topicId, title: topic ? `${timestamp}_${topic}` : project.title, updatedAt: project.updatedAt };
}

export function newProject(topicId: string): Project {
  // 新建文章用创建时刻作为默认标题，避免多个未命名项目难以区分。
  const createdAt = new Date();
  return {
    id: createUuid(),
    topicId,
    title: formatProjectTimestamp(createdAt),
    source: "",
    url: "",
    stage: "analysis",
    results: { analysis: "", topics: "", outline: "", article: "" },
    articleNeedsRegeneration: false,
    articleVersions: [],
    finalizations: [],
    selectedTopic: "",
    coreDirection: "",
    directionTopic: "",
    directionConfirmed: false,
    outlineConfirmed: false,
    topicReviewPending: false,
    outlineBasis: "",
    memoryOutbox: [],
    messages: [],
    updatedAt: new Date().toISOString(),
  };
}

// 进入正文必须拥有当前标题、已确认方向和已确认大纲，两套专题使用同一闸门。
export function canWriteArticle(project: Project): boolean {
  return Boolean(!project.topicReviewPending && hasConfirmedDirection(project) &&
    project.selectedTopic.trim() && project.results.analysis.trim() &&
    project.results.outline.trim() && project.outlineConfirmed);
}

// 保存完整依据便于比较，不包含正文，正文修改不会触发上游覆盖。
export function outlineBasis(project: Project): string {
  return JSON.stringify([project.topicId, project.source, project.url, project.results.analysis,
    project.selectedTopic, project.coreDirection, project.directionTopic]);
}

// 方向是否对应当前题目，与是否经过人工审核分别判断。
export function hasCurrentDirection(project: Project): boolean {
  return Boolean(project.selectedTopic.trim() && project.coreDirection.trim() &&
    project.directionTopic === project.selectedTopic);
}

export function hasConfirmedDirection(project: Project): boolean {
  return !isWritingTopic(project.topicId) || (hasCurrentDirection(project) && project.directionConfirmed);
}

// 前后端共用失效规则：保留成果供查看，但上游变化后必须重新整理方向。
export function invalidateDirection(project: Project, previous: Project): Project {
  const upstreamChanged = project.topicId !== previous.topicId ||
    project.source !== previous.source || project.url !== previous.url ||
    project.results.analysis !== previous.results.analysis ||
    project.selectedTopic !== previous.selectedTopic;
  // 普通扩展专题沿用原有确认行为；两套已注册专题要求方向重新确认。
  if (!isWritingTopic(project.topicId) && !isWritingTopic(previous.topicId))
    return upstreamChanged ? { ...project, outlineConfirmed: false } : project;
  const directionChanged = project.coreDirection !== previous.coreDirection ||
    project.directionTopic !== previous.directionTopic;
  if (!upstreamChanged && !directionChanged) return project;
  return { ...project, directionTopic: upstreamChanged ? "" : project.directionTopic,
    directionConfirmed: false, outlineConfirmed: false };
}
