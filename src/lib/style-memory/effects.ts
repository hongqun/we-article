import type { ArticleVersion, Finalization, Project } from "../project";
import type { MemoryEvent, MemoryUsage } from "./types";

export type ManualEditSession = { id: string; startedAt: string; finishedAt: string; before: string; after: string; savedCount: number };

// 一次手改从首次保存持续到下一次非手工写作动作，不按时间切碎同一轮编辑。
export function manualEditSessions(events: MemoryEvent[]): ManualEditSession[] {
  const sessions: ManualEditSession[] = [];
  let current: ManualEditSession | undefined;
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (event.stage !== "article" || event.operation !== "stage") continue;
    if (event.kind === "manual" && event.target === "article" && event.before !== event.after) {
      if (!current) {
        current = { id: event.id, startedAt: event.createdAt, finishedAt: event.createdAt,
          before: event.before, after: event.after, savedCount: 1 };
        sessions.push(current);
      } else { current.finishedAt = event.createdAt; current.after = event.after; current.savedCount += 1; }
    } else current = undefined;
  }
  return sessions;
}

// 统计与编辑页共用同一编辑边界，避免自动保存次数被误认为反复否定模型。
export function editingSessions(events: MemoryEvent[]) {
  const manualSessions = manualEditSessions(events).length;
  let feedbackCount = 0;
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (event.stage !== "article" || event.operation !== "stage") continue;
    if (event.kind === "feedback" && event.instruction.trim()) feedbackCount++;
  }
  return { manualSessions, feedbackCount, editCount: manualSessions + feedbackCount };
}

// 相邻双字重合度衡量文字变化，不评判语义或风格；移除空白可减少排版噪声。
export function textChangePercent(before: string, after: string): number | null {
  const a = Array.from(before.replace(/\s/g, ""));
  const b = Array.from(after.replace(/\s/g, ""));
  if (!a.length || !b.length) return null;
  if (a.join("") === b.join("")) return 0;
  if (a.length < 2 || b.length < 2) return 100;
  const pairs = new Map<string, number>();
  for (let i = 1; i < a.length; i++) { const key = a[i - 1] + a[i]; pairs.set(key, (pairs.get(key) ?? 0) + 1); }
  let overlap = 0;
  for (let i = 1; i < b.length; i++) {
    const key = b[i - 1] + b[i]; const count = pairs.get(key) ?? 0;
    if (count) { overlap++; pairs.set(key, count - 1); }
  }
  return Math.round((1 - 2 * overlap / (a.length + b.length - 2)) * 100);
}

export function versionUsage(version: ArticleVersion, events: MemoryEvent[]): MemoryUsage | undefined {
  // 新版本按请求 ID 精确关联；旧版只在正文和时间都匹配时恢复关联，不猜测最近调用。
  const model = version.requestId ? undefined : events.find(event => event.kind === "model" &&
    event.stage === "article" && event.operation === "stage" && event.after === version.content &&
    Math.abs(Date.parse(event.createdAt) - Date.parse(version.createdAt)) < 2000);
  const requestId = version.requestId ?? model?.relatedId;
  if (!requestId) return undefined;
  return events.find(event => event.kind === "usage" && event.stage === "article" &&
    event.operation === "stage" && event.relatedId === requestId)?.usage;
}

export function finalArticleEffect(project: Project, record: Finalization, events: MemoryEvent[]) {
  const index = project.articleVersions.findIndex(item => item.id === record.articleVersionId);
  const versions = index < 0 ? [] : project.articleVersions.slice(0, index + 1);
  const final = versions.at(-1);
  // 切换专题后旧版本仍可恢复，但旧专题模型稿不能作为当前专题的效果基线。
  const generated = versions.filter(item => (item.source === "generation" || item.source === "rewrite") &&
    (item.topicId === record.topicId || (!item.topicId && events.some(event => event.kind === "model" &&
      event.stage === "article" && event.after === item.content &&
      Math.abs(Date.parse(event.createdAt) - Date.parse(item.createdAt)) < 2000))));
  const baseline = [...generated].reverse().find(item => item.source === "generation") ?? generated[0];
  const latest = generated.at(-1);
  const usage = baseline ? versionUsage(baseline, events) : undefined;
  const known = Boolean(usage && !usage.redacted);
  const startedAt = baseline?.createdAt;
  const edits = events.filter(event => event.createdAt <= record.createdAt && (!startedAt || event.createdAt > startedAt));
  return {
    ...editingSessions(edits),
    baselineKnown: Boolean(baseline && final),
    styleUsed: known ? Boolean(usage!.trendIds.length || usage!.exampleIds.length) : null,
    versionId: usage?.versionId ?? null,
    trendIds: known ? usage!.trendIds : [],
    exampleCount: known ? usage!.exampleIds.length : 0,
    changePercent: baseline && final ? textChangePercent(baseline.content, final.content) : null,
    finalTouchPercent: latest && final ? textChangePercent(latest.content, final.content) : null,
    generatedCount: baseline ? generated.filter(item => item.createdAt >= baseline.createdAt).length : 0,
  };
}
