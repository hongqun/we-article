import { z } from "zod";

// 仅保存可见反馈与成果，不保存模型思考；事件 ID 使旧数据迁移与事件写入可重试。
export const memoryEventSchema = z.object({
  id: z.string().uuid(), createdAt: z.string(), projectId: z.string().uuid(),
  topicId: z.string().regex(/^[a-z][a-z0-9-]*$/), stage: z.enum(["analysis", "topics", "outline", "article"]),
  operation: z.enum(["stage", "direction"]), target: z.string(),
  kind: z.enum(["manual", "feedback", "button", "model", "restore", "context", "correction", "usage"]),
  before: z.string(), after: z.string(), instruction: z.string().default(""),
  relatedId: z.string().optional(), title: z.string(), direction: z.string(),
  usage: z.object({ versionId: z.number().nullable(), trendIds: z.array(z.string()),
    exampleIds: z.array(z.string()), context: z.string(),
    // 来源被删除时清除引用文本，保留历史调用的统计事实。
    redacted: z.boolean().optional(), hadMemory: z.boolean().optional() }).optional(),
});
export type MemoryEvent = z.infer<typeof memoryEventSchema>;
export type MemoryUsage = NonNullable<MemoryEvent["usage"]>;
export type TrendStatus = "observing" | "active" | "conflicted" | "disabled";
export type Evidence = { eventId: string; relation: "support" | "oppose" | "revision"; quote: string; explicit: boolean; resolved: boolean };
export type Trend = { id: string; text: string; stage: MemoryEvent["stage"]; operation: MemoryEvent["operation"];
  // scene 以“通用/”或具体文章类型开头，既保留专题通用画像，也支持按类型筛选。
  scene: string; status: TrendStatus; userEdited: boolean; updatedAt: string; evidence: Evidence[];
  supportProjectCount?: number };
export type MemoryVersion = { id: number; createdAt: string; reason: string; trends: Trend[] };
export type SummaryRun = { id: string; mode: string; day: string; startedAt: string; finishedAt: string | null;
  status: string; error: string | null; throughSeq: number };
export type MemoryView = { trends: Trend[]; versions: MemoryVersion[]; runs: SummaryRun[];
  pendingCount: number; lastSuccess: string | null; events: MemoryEvent[] };

// 模型只能建议倾向与证据，启用门槛、停用保护和游标推进由程序决定。
export const summarySchema = z.object({ changes: z.array(z.object({
  existingId: z.string().nullable(), text: z.string().min(1).max(240),
  stage: z.enum(["analysis", "topics", "outline", "article"]), operation: z.enum(["stage", "direction"]),
  scene: z.string().min(1).max(80),
  evidence: z.array(z.object({ eventId: z.string(), relation: z.enum(["support", "oppose"]),
    quote: z.string().min(1).max(500), explicit: z.boolean() })).min(1).max(12),
})).max(20) });
export type SummaryResult = z.infer<typeof summarySchema>;
export const SUPPORT_PROJECTS = 3;
export const LOCAL_USER = "local-user";
export type MemoryTopic = MemoryEvent["topicId"];
