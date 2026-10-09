import { z } from "zod";
import { projectSchema, toProjectSummary, invalidateDirection, hasCurrentDirection, hasConfirmedDirection, hasProjectContent, outlineBasis, type Project, type ProjectSummary, type ArticleVersion, type Finalization } from "./project";
import { readWritingTopic } from "./topics";
import { collectEdits, makeEvent, targetText } from "./style-memory/events";
import type { MemoryUsage } from "./style-memory/types";
import { articleDatabase } from "./database";
import { memoryStore } from "./style-memory/store";
import { shouldAppendManualVersion } from "./article-autosave";
import { isWritingTopic } from "./topic-policy";

// 同一进程内串行保存与转存，避免清理待办时覆盖另一个请求刚写入的修改。
const storageGlobal = globalThis as typeof globalThis & { articleProjectLocks?: Map<string, Promise<unknown>> };
const locks = storageGlobal.articleProjectLocks ??= new Map<string, Promise<unknown>>();
async function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(fn);
  locks.set(id, current);
  try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}
// 项目、版本和修改事件在一个 SQLite 事务中保存，不再产生文章 JSON。
function writeProject(project: Project) {
  const database = articleDatabase();
  const stores = [...new Set(project.memoryOutbox.map(event => event.topicId))].map(memoryStore);
  database.db.transaction(() => {
    for (const store of stores) store.ingest(project.memoryOutbox.filter(event => event.topicId === store.topicId));
    database.write({ ...project, memoryOutbox: [] });
  })();
  project.memoryOutbox = [];
}
async function flushOutbox(project: Project): Promise<Project> {
  if (project.memoryOutbox.length) writeProject(project);
  return project;
}
function readRawProject(id: string): Project {
  return articleDatabase().read(z.string().uuid().parse(id));
}
export async function readProject(id: string): Promise<Project> {
  return serialized(id, async () => flushOutbox(readRawProject(id)));
}
// 仅旧版迁移可能留下待办；转存失败保留库内原记录，并明确反馈错误。
export async function retryMemoryOutboxes() {
  for (const id of articleDatabase().ids()) await readProject(id);
}
export async function deleteProject(id: string) {
  z.string().uuid().parse(id);
  return serialized(id, async () => {
    const database = articleDatabase();
    const projects = database.ids().map(projectId => database.read(projectId));
    const topicIds = new Set(projects.flatMap(project => [project.topicId,
      ...project.finalizations.map(item => item.topicId), ...project.memoryOutbox.map(event => event.topicId)]));
    const stores = [...topicIds].map(memoryStore);
    database.remove(id, () => {
      // 迁移待办也可能含跨文章引用，先在同一事务中转存，避免删后被补写回来。
      for (const projectId of database.ids()) {
        const project = database.read(projectId);
        if (project.memoryOutbox.length) writeProject(project);
      }
      for (const store of stores) store.deleteProjectEvidence(id);
    });
  });
}
type SaveOptions = { source?: ArticleVersion["source"]; summary?: string; restoreVersionId?: string; autosave?: boolean;
  confirmDirection?: boolean; confirmTopic?: boolean; confirmOutline?: boolean; restoreOutlineId?: string;
  resetDirectionConfirmation?: boolean;
  feedback?: { id: string; instruction: string; source: "user" | "button"; operation: "stage" | "direction" };
  generated?: { operation: "stage" | "direction"; relatedId: string; regenerateFromOutline?: boolean }; usage?: MemoryUsage;
  usageRelatedId?: string; usageOperation?: "stage" | "direction" };
export async function saveProject(value: unknown, options: SaveOptions = {}): Promise<Project> {
  const id = projectSchema.parse(value).id;
  return serialized(id, () => saveProjectUnlocked(value, options));
}
// 只信任数据库中的历史，避免旧页面保存时覆盖已经存在的版本。
async function saveProjectUnlocked(
  value: unknown,
  options: SaveOptions = {},
): Promise<Project> {
  let project = projectSchema.parse(value);
  // 项目只允许使用已配置的专题；删除通用专题后不能从旧请求重新创建。
  const topic = await readWritingTopic(project.topicId);
  const styleMemoryEnabled = topic.styleMemory;
  let previous: Project | undefined;
  try {
    previous = await readRawProject(project.id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!hasProjectContent(project)) throw new Error("项目没有内容，填写材料后才能保存。");
  // 还原系统修订前大纲时只读取服务端快照，不把按钮操作当作用户手写风格证据。
  const restoredOutline = options.restoreOutlineId
    ? previous?.finalizations.find(item => item.id === options.restoreOutlineId && item.topicId === project.topicId &&
      item.status === "completed" && item.structuralChange)
    : undefined;
  if (options.restoreOutlineId && !restoredOutline) throw new Error("找不到本专题的成稿前大纲。");
  if (restoredOutline) {
    project.results.outline = restoredOutline.originalOutline;
    project.outlineConfirmed = false;
  }
  // 切换专题保留成果，回到最早待复核阶段；旧专题确认状态不能带入新专题。
  project.topicReviewPending = previous?.topicReviewPending ?? false;
  if (previous && previous.topicId !== project.topicId) {
    project.outlineConfirmed = false;
    project.topicReviewPending = isWritingTopic(project.topicId);
    project.stage = project.results.analysis.trim() ? "topics" : "analysis";
  }
  if (options.confirmTopic && (!isWritingTopic(project.topicId) || !project.selectedTopic.trim() ||
    !project.results.analysis.trim() || project.stage !== "outline"))
    throw new Error("请先完成材料解读并选定标题，再进入大纲。");
  // 确认只能通过显式操作完成，客户端普通保存不能自行升级确认状态。
  project.directionConfirmed = project.directionConfirmed && (previous?.directionConfirmed ?? false);
  // 用户同时编辑题目和方向时，显式绑定的新方向可直接使用，不要求先调用模型。
  const manualDirection = !options.generated && isWritingTopic(project.topicId) &&
    (!previous || previous.topicId === project.topicId) && project.coreDirection !== previous?.coreDirection &&
    hasCurrentDirection(project);
  if (previous) project = invalidateDirection(project, previous);
  if (manualDirection) project.directionTopic = project.selectedTopic;
  if (options.resetDirectionConfirmation) {
    project.directionConfirmed = false;
    project.outlineConfirmed = false;
  }
  if (options.confirmDirection) {
    if (!isWritingTopic(project.topicId) || !hasCurrentDirection(project))
      throw new Error("请先根据当前标题调整核心方向，再确认。");
    project.directionConfirmed = true;
  }
  if (options.confirmTopic) {
    if (!project.directionConfirmed) throw new Error("请先确认当前标题和核心方向。");
    project.topicReviewPending = false;
  }
  // 大纲确认由服务端操作授予；普通保存或客户端改字段不能绕过正文入口。
  project.outlineConfirmed = project.outlineConfirmed && (previous?.outlineConfirmed ?? false);
  if (previous && previous.results.outline !== project.results.outline) project.outlineConfirmed = false;
  project.articleNeedsRegeneration = previous?.articleNeedsRegeneration ?? false;
  if (previous && previous.results.outline !== project.results.outline && previous.results.article.trim())
    project.articleNeedsRegeneration = true;
  if (options.confirmOutline) {
    if (project.stage !== "article" ||
      !hasConfirmedDirection(project) || !project.results.outline.trim() || project.topicReviewPending)
      throw new Error("请先完成并确认当前标题、方向和大纲。");
    if (isWritingTopic(project.topicId) && project.outlineBasis !== outlineBasis(project) &&
      previous?.results.outline === project.results.outline &&
      (!previous?.outlineConfirmed || outlineBasis(previous) !== outlineBasis(project)))
      throw new Error("题目或方向已变化，请先修改或重新生成大纲，再确认进入正文。");
    project.outlineConfirmed = true;
  }
  if (options.generated?.operation === "stage" && project.stage === "article" &&
    (options.generated.regenerateFromOutline || !previous?.results.article.trim()))
    project.articleNeedsRegeneration = false;
  // 准备依据只由服务端维护；正文保存不刷新大纲，手动调整大纲可用于下一次写作。
  project.outlineBasis = previous?.outlineBasis ?? "";
  // 旧版已确认且依据未变的大纲可直接沿用，升级不强制重写用户审核过的成果。
  if (!project.outlineBasis && previous?.outlineConfirmed && hasCurrentDirection(previous) &&
    previous.results.outline.trim() && outlineBasis(previous) === outlineBasis(project)) {
    project.outlineBasis = outlineBasis(project);
  }
  if (isWritingTopic(project.topicId) && hasCurrentDirection(project) && project.results.outline.trim() &&
    ((options.generated?.operation === "stage" && project.stage === "outline") ||
      (!options.generated && previous?.results.outline !== project.results.outline))) {
    project.outlineBasis = outlineBasis(project);
  }
  // 原始事件与文章同一次事务提交，待办历史只信任数据库版本。
  project.memoryOutbox = [...(previous?.memoryOutbox ?? [])];
  const generatedTarget = options.restoreOutlineId ? "outline" :
    options.generated ? (options.generated.operation === "direction" ? "coreDirection" : project.stage) : undefined;
  project.memoryOutbox.push(...collectEdits(previous, project, generatedTarget, styleMemoryEnabled));
  if (restoredOutline && previous && styleMemoryEnabled)
    project.memoryOutbox.push(makeEvent(project, { kind: "restore", stage: "outline", target: "outline",
      before: previous.results.outline, after: project.results.outline, relatedId: restoredOutline.id }));
  if (styleMemoryEnabled && options.feedback) {
    const feedback = options.feedback;
    project.memoryOutbox.push(makeEvent(project, { id: feedback.id, kind: feedback.source === "user" ? "feedback" : "button",
      operation: feedback.operation, target: feedback.operation === "direction" ? "coreDirection" : project.stage,
      instruction: feedback.instruction, before: targetText(project, feedback.operation), after: "" }));
  }
  if (styleMemoryEnabled && options.generated) {
    project.memoryOutbox.push(makeEvent(project, { kind: "model", operation: options.generated.operation,
      // 修改前文本必须来自同一目标，不能取旧页面所在阶段。
      target: generatedTarget!, before: previous ? targetText({ ...previous, stage: project.stage }, options.generated.operation) : "",
      after: targetText(project, options.generated.operation), relatedId: options.generated.relatedId }));
  }
  if (styleMemoryEnabled && options.usage) {
    project.memoryOutbox.push(makeEvent(project, { kind: "usage", target: project.stage, before: "", after: "",
      relatedId: options.usageRelatedId ?? options.generated?.relatedId, operation: options.usageOperation ?? "stage", usage: options.usage }));
  }
  project.articleVersions = previous?.articleVersions ?? [];
  // 成稿记录只由服务端维护，页面保存不能覆盖已有快照。
  project.finalizations = previous?.finalizations ?? [];
  const append = (source: ArticleVersion["source"], summary: string) => {
    project.articleVersions.push({
      id: crypto.randomUUID(), createdAt: new Date().toISOString(),
      content: project.results.article, source, summary: summary.slice(0, 200), topicId: project.topicId,
      ...(options.generated ? { requestId: options.generated.relatedId } : {}),
      ...(options.autosave && source === "manual" ? { autosaved: true } : {}),
    });
  };
  const retainEdits = () => {
    const latest = project.articleVersions.at(-1);
    if (shouldAppendManualVersion(latest, project.results.article, options.restoreVersionId ? false : options.autosave))
      append("manual", options.autosave ? "自动保存正文快照" : "保存手动编辑的正文");
  };
  if (options.restoreVersionId) {
    const target = project.articleVersions.find((version) => version.id === options.restoreVersionId);
    if (!target) throw new Error("文章版本不存在，请重新打开项目。");
    // 先留存当前编辑，再复制历史正文；选题、大纲和聊天记录保持当前状态。
    retainEdits();
    if (styleMemoryEnabled) project.memoryOutbox.push(makeEvent(project, {
      kind: "restore", stage: "article", target: "article", before: project.results.article, after: target.content, relatedId: target.id,
    }));
    project.results.article = target.content;
    append("restore", `恢复 ${target.createdAt} 的版本`);
  } else if (options.source) {
    append(options.source, options.summary ?? "更新文章正文");
  } else {
    retainEdits();
  }
  project.updatedAt = new Date().toISOString();
  await writeProject(project);
  return flushOutbox(project);
}
export async function listProjects(): Promise<ProjectSummary[]> {
  const projects = await readAllProjects();
  return projects.filter(hasProjectContent).map(toProjectSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// 一次性清理历史空项目，复用删除事务以同步清理版本和学习证据。
export async function cleanupEmptyProjects(): Promise<string[]> {
  const ids = articleDatabase().ids();
  const emptyIds: string[] = [];
  for (const id of ids) {
    const project = await readProject(id);
    if (!hasProjectContent(project)) {
      await deleteProject(id);
      emptyIds.push(id);
    }
  }
  return emptyIds;
}

// 成稿操作先锁定正文版本；重试同一版本时复用记录，不重复计入统计。
export async function beginFinalization(id: string, articleVersionId: string): Promise<{ project: Project; record: Finalization }> {
  return serialized(id, async () => {
    const project = await readRawProject(id);
    const latest = project.articleVersions.at(-1);
    if (project.stage !== "article" || !latest || latest.id !== articleVersionId ||
      latest.content !== project.results.article || !project.results.article.trim())
      throw new Error("正文已变化，请保存最新正文后重新成稿。");
    let record = project.finalizations.find(item => item.articleVersionId === articleVersionId &&
      item.topicId === project.topicId);
    if (record?.status === "pending" && Date.now() - Date.parse(record.createdAt) < 5 * 60 * 1000)
      throw new Error("本篇成稿正在处理中，请稍后重新打开项目。");
    if (record?.status === "completed") return { project, record };
    record = { id: record?.id ?? crypto.randomUUID(), articleVersionId, topicId: project.topicId,
      createdAt: new Date().toISOString(), status: "pending", originalOutline: project.results.outline,
      revisedOutline: null, structuralChange: null, reason: "", feedbackCount: 0,
      manualEdited: false, styleUsed: false };
    project.finalizations = [...project.finalizations.filter(item => item.id !== record!.id), record];
    await writeProject(project);
    return { project, record };
  });
}

export async function finishFinalization(id: string, recordId: string,
  outcome: { structuralChange: boolean; reason: string; revisedOutline: string | null;
    feedbackCount: number; manualEdited: boolean; styleUsed: boolean }): Promise<Project> {
  return serialized(id, async () => {
    const project = await readRawProject(id);
    const record = project.finalizations.find(item => item.id === recordId);
    if (!record || record.status !== "pending") throw new Error("成稿记录已经变化，请重新打开项目。");
    const latest = project.articleVersions.at(-1);
    if (!latest || latest.id !== record.articleVersionId || latest.content !== project.results.article)
      throw new Error("正文在判断期间发生变化，请重新成稿。");
    if (outcome.structuralChange) {
      if (!outcome.revisedOutline?.trim()) throw new Error("结构已变化，但没有得到可保存的大纲修订稿。");
      // 系统只修订本篇大纲；保留原文快照，且不把模型修订标成用户确认。
      project.results.outline = outcome.revisedOutline.trim();
      project.outlineConfirmed = false;
    }
    Object.assign(record, { ...outcome, status: "completed" as const });
    project.updatedAt = new Date().toISOString();
    await writeProject(project);
    return project;
  });
}

export async function failFinalization(id: string, recordId: string, reason: string) {
  return serialized(id, async () => {
    const project = await readRawProject(id);
    const record = project.finalizations.find(item => item.id === recordId);
    if (record?.status === "pending") {
      record.status = "failed";
      record.reason = reason.slice(0, 500);
      await writeProject(project);
    }
  });
}

// 概览页读取全部项目的最新状态，不触发模型或写作流程。
export async function readAllProjects(): Promise<Project[]> {
  return articleDatabase().ids().map(id => readRawProject(id));
}
