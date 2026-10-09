import type { Project } from "../project";
import type { MemoryEvent } from "./types";

export function makeEvent(project: Project, fields: Pick<MemoryEvent, "kind" | "target" | "before" | "after"> & Partial<MemoryEvent>): MemoryEvent {
  return { id: crypto.randomUUID(), createdAt: new Date().toISOString(), projectId: project.id,
    topicId: project.topicId, stage: project.stage, operation: "stage", instruction: "",
    title: project.selectedTopic, direction: project.coreDirection, ...fields };
}
export function targetText(project: Project, operation: "stage" | "direction") {
  return operation === "direction" ? project.coreDirection : project.results[project.stage];
}

export type StyleEditSession = {
  projectId: string;
  topicId: MemoryEvent["topicId"];
  stage: MemoryEvent["stage"];
  operation: MemoryEvent["operation"];
  target: string;
  eventIds: string[];
  before: string;
  after: string;
  instructions: string[];
  title: string;
  direction: string;
  // 聚合只减少模型看到的会话数量，不能丢失每个事件与原文的对应关系。
  eventSources: Array<{ eventId: string; kind: MemoryEvent["kind"]; before: string; after: string; instruction: string }>;
};

// 连续自动保存属于同一轮人工编辑；保留原事件 ID，画像证据仍可回溯到真实修改。
export function groupStyleEditSessions(events: MemoryEvent[], gapMs = 5 * 60 * 1000): StyleEditSession[] {
  const sessions: StyleEditSession[] = [];
  const ordered = [...events].filter(event => event.kind === "manual" || event.kind === "feedback")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const event of ordered) {
    const previous = sessions.at(-1);
    const previousEvent = previous?.eventIds.length
      ? ordered.find(item => item.id === previous.eventIds.at(-1))
      : undefined;
    const adjacent = previous && previous.projectId === event.projectId && previous.stage === event.stage &&
      previous.operation === event.operation && previous.target === event.target && previousEvent &&
      Date.parse(event.createdAt) - Date.parse(previousEvent.createdAt) <= gapMs;
    if (adjacent) {
      previous.eventIds.push(event.id);
      if (event.kind === "feedback" && event.instruction.trim()) previous.instructions.push(event.instruction.trim());
      previous.after = event.kind === "manual" ? event.after : previous.after;
      previous.eventSources.push({ eventId: event.id, kind: event.kind, before: event.before, after: event.after, instruction: event.instruction });
      continue;
    }
    sessions.push({ projectId: event.projectId, topicId: event.topicId, stage: event.stage, operation: event.operation,
      target: event.target, eventIds: [event.id], before: event.before, after: event.after,
      instructions: event.kind === "feedback" && event.instruction.trim() ? [event.instruction.trim()] : [],
      title: event.title, direction: event.direction,
      eventSources: [{ eventId: event.id, kind: event.kind, before: event.before, after: event.after, instruction: event.instruction }] });
  }
  return sessions;
}

// 原始材料和专题切换只作上下文；模型输出通过专用来源标记，不能混入手动编辑。
export function collectEdits(previous: Project | undefined, project: Project, generatedTarget?: string, enabled = true): MemoryEvent[] {
  if (!enabled || (previous && previous.topicId !== project.topicId)) return [];
  const events: MemoryEvent[] = [];
  const fields = [
    ...(["analysis", "topics", "outline", "article"] as const).map(stage => ({ target: stage, stage,
      operation: "stage" as const, before: previous?.results[stage] ?? "", after: project.results[stage] })),
    { target: "selectedTopic", stage: "topics" as const, operation: "stage" as const, before: previous?.selectedTopic ?? "", after: project.selectedTopic },
    { target: "coreDirection", stage: "topics" as const, operation: "direction" as const, before: previous?.coreDirection ?? "", after: project.coreDirection },
  ];
  for (const field of fields) {
    if (field.target !== generatedTarget && field.before !== field.after) {
      // 沿用完整候选不是手写标题；仅匹配整行，缩写或重写仍保留真实修改。
      const candidateSelection = field.target === "selectedTopic" && field.after.trim() &&
        (previous?.results.topics ?? project.results.topics).split(/\r?\n/).some(line =>
          line.replace(/^\s*(?:#{1,6}\s+)?(?:(?:[-*+]|\d+[.、)）])\s+)?/, "")
            .replace(/[*_`]/g, "").trim() === field.after.trim());
      events.push(makeEvent(project, { kind: candidateSelection ? "context" : "manual", ...field }));
    }
  }
  if (previous && (previous.source !== project.source || previous.url !== project.url))
    events.push(makeEvent(project, { kind: "context", target: "source", before: previous.source, after: project.source }));
  return events;
}
