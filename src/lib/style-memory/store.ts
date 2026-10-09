import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { articleDatabase } from "../database";
import { LOCAL_USER, SUPPORT_PROJECTS, summarySchema,
  type MemoryEvent, type MemoryTopic, type Trend, type MemoryVersion, type SummaryRun, type MemoryView, type SummaryResult } from "./types";

const LEASE_MS = 5 * 60 * 1000;
// 风格总结使用单次模型请求；控制输入规模，避免思考模式下超过模型客户端的 120 秒超时。
const BATCH_EVENTS = 8;
const BATCH_CHARS = 30000;
type EventRow = { seq: number; payload: string };
export type SummaryBatch = { runId: string; baseVersion: number | null; throughSeq: number; throughOffset: number; events: MemoryEvent[]; trends: Trend[] };
const identity = (text: string) => text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "").toLowerCase();

// 只保留不可还原的停用指纹，避免来源删除后仍存有派生文本。
const suppressionKey = (trend: Pick<Trend, "stage" | "operation" | "text">) =>
  createHash("sha256").update(`${trend.stage}/${trend.operation}/${identity(trend.text)}`).digest("hex");

// 每个连接都启用事务约束；模型等待期间不持有写锁。构造器允许测试使用内存库。
export class StyleMemoryStore {
  readonly db: Database.Database;
  readonly scope: string;
  constructor(filename: string | Database.Database, readonly topicId: MemoryTopic) {
    this.scope = `${LOCAL_USER}/${topicId}`;
    if (typeof filename === "string" && filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    // 生产环境共用文章连接，使项目删除与证据清理处于同一事务。
    this.db = typeof filename === "string" ? new Database(filename) : filename;
    this.db.pragma("busy_timeout = 5000");
    // 使用回滚日志模式，事务提交后主库就是完整资产，避免 Git 只收录主库却遗漏 WAL。
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
    this.db.transaction(() => {
      const version = this.db.pragma("user_version", { simple: true }) as number;
      if (version > 1) throw new Error("风格数据库版本高于当前程序，请升级程序。");
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            scope TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX events_scope_seq ON events(scope, seq);
          CREATE TABLE trends (id TEXT PRIMARY KEY, scope TEXT NOT NULL, identity TEXT NOT NULL,
            payload TEXT NOT NULL, UNIQUE(scope, identity));
          CREATE TABLE evidence (trend_id TEXT NOT NULL REFERENCES trends(id), event_id TEXT NOT NULL REFERENCES events(id),
            relation TEXT NOT NULL, quote TEXT NOT NULL, explicit INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(trend_id, event_id, relation));
          CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
            created_at TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE state (scope TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, cursor_offset INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, mode TEXT NOT NULL, day TEXT NOT NULL,
            started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, error TEXT,
            through_seq INTEGER NOT NULL, through_offset INTEGER NOT NULL DEFAULT 0, base_version INTEGER);
          CREATE INDEX runs_scope_day ON runs(scope, day);
          CREATE UNIQUE INDEX one_running_summary ON runs(scope) WHERE status = 'running';
          PRAGMA user_version = 1;
        `);
      }
      this.db.prepare("INSERT OR IGNORE INTO state(scope) VALUES (?)").run(this.scope);
      // 删除来源后仍保留用户的停用选择，只留规则指纹，不留原始证据。
      this.db.exec("CREATE TABLE IF NOT EXISTS suppressed_styles (scope TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(scope,identity))");
      this.db.exec("CREATE TABLE IF NOT EXISTS deleted_projects (id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL)");
    }).immediate();
  }
  close() { this.db.close(); }
  ingest(events: MemoryEvent[]) {
    if (events.some(event => event.topicId !== this.topicId)) throw new Error("风格事件与专题作用域不一致。");
    this.db.transaction(() => {
      const insert = this.db.prepare("INSERT OR IGNORE INTO events(id,scope,project_id,kind,payload) VALUES (?,?,?,?,?)");
      for (const event of events) {
        if (this.db.prepare("SELECT 1 FROM deleted_projects WHERE id=?").get(event.projectId))
          throw new Error("项目已删除，不能补写学习证据。");
        // 在途请求可能仍持有被删来源的参考；持久化前再次检查，不能重新落盘旧引用。
        const usage = event.usage;
        if (usage && (usage.trendIds.some(id => !this.db.prepare("SELECT 1 FROM trends WHERE scope=? AND id=?").get(this.scope, id)) ||
          usage.exampleIds.some(id => !this.db.prepare("SELECT 1 FROM events WHERE scope=? AND id=?").get(this.scope, id)))) {
          Object.assign(usage, { trendIds: [], exampleIds: [], context: "", redacted: true, hadMemory: true });
        }
        insert.run(event.id, this.scope, event.projectId, event.kind, JSON.stringify(event));
      }
    }).immediate();
  }
  // 删除项目时同步撤回派生倾向、历史引用与在途总结，剩余证据等待重新整理。
  deleteProjectEvidence(projectId: string) {
    this.db.transaction(() => {
      const removed = new Set(this.projectEvents(projectId).map(event => event.id));
      if (!removed.size) return;
      const affected = this.trends().filter(trend => trend.evidence.some(item => removed.has(item.eventId)));
      const affectedIds = new Set(affected.map(trend => trend.id));
      for (const trend of affected) {
        if (trend.status === "disabled") this.db.prepare("INSERT OR IGNORE INTO suppressed_styles(scope,identity) VALUES (?,?)")
          .run(this.scope, suppressionKey(trend));
        this.db.prepare("DELETE FROM evidence WHERE trend_id=?").run(trend.id);
        this.db.prepare("DELETE FROM trends WHERE id=?").run(trend.id);
      }
      // 用户直接修订的原话也可能带有删除项目的上下文，关联记录一并清除。
      const corrections = this.db.prepare<[string], { id: string; payload: string }>("SELECT id,payload FROM events WHERE scope=? AND kind='correction'").all(this.scope);
      for (const row of corrections) if (affectedIds.has((JSON.parse(row.payload) as MemoryEvent).target)) {
        this.db.prepare("DELETE FROM evidence WHERE event_id=?").run(row.id);
        this.db.prepare("DELETE FROM events WHERE id=?").run(row.id);
      }
      this.db.prepare("DELETE FROM evidence WHERE event_id IN (SELECT id FROM events WHERE scope=? AND project_id=?)").run(this.scope, projectId);
      this.db.prepare("DELETE FROM events WHERE scope=? AND project_id=?").run(this.scope, projectId);
      const versions = this.db.prepare<[string], { id: number; payload: string }>("SELECT id,payload FROM versions WHERE scope=?").all(this.scope);
      for (const row of versions) {
        const trends = (JSON.parse(row.payload) as Trend[]).filter(trend => !affectedIds.has(trend.id) &&
          !trend.evidence.some(item => removed.has(item.eventId)));
        this.db.prepare("UPDATE versions SET payload=? WHERE id=?").run(JSON.stringify(trends), row.id);
      }
      // 其他项目的调用快照可能复制了被删证据；清掉参考原文，但保留曾使用记忆的事实。
      const usages = this.db.prepare<[string], { id: string; payload: string }>("SELECT id,payload FROM events WHERE scope=? AND kind='usage'").all(this.scope);
      for (const row of usages) {
        const event = JSON.parse(row.payload) as MemoryEvent;
        if (!event.usage || (!event.usage.trendIds.some(id => affectedIds.has(id)) &&
          !event.usage.exampleIds.some(id => removed.has(id)))) continue;
        event.usage = { versionId: event.usage.versionId, trendIds: [], exampleIds: [], context: "",
          redacted: true, hadMemory: true };
        this.db.prepare("UPDATE events SET payload=? WHERE id=?").run(JSON.stringify(event), row.id);
      }
      // 运行错误可能包含原始引用，删除相关专题运行日志；旧批次不能再提交。
      this.db.prepare("DELETE FROM runs WHERE scope=?").run(this.scope);
      this.db.prepare("UPDATE state SET cursor=0,cursor_offset=0 WHERE scope=?").run(this.scope);
      this.snapshot("删除项目后撤回相关学习，剩余证据待重新整理");
    })();
  }
  events(ids: string[]): MemoryEvent[] {
    const get = this.db.prepare<[string, string], { payload: string }>("SELECT payload FROM events WHERE scope=? AND id=?");
    return [...new Set(ids)].flatMap(id => { const row = get.get(this.scope, id); return row ? [JSON.parse(row.payload) as MemoryEvent] : []; });
  }
  // 概览与成稿统计只读取当前专题、当前项目的事件，不返回证据全文给页面。
  projectEvents(projectId: string): MemoryEvent[] {
    const rows = this.db.prepare<[string, string], { payload: string }>(
      "SELECT payload FROM events WHERE scope=? AND project_id=? ORDER BY seq",
    ).all(this.scope, projectId);
    return rows.map(row => JSON.parse(row.payload) as MemoryEvent);
  }
  eventCounts() {
    const rows = this.db.prepare<[string], { kind: string; count: number }>(
      "SELECT kind, count(*) AS count FROM events WHERE scope=? GROUP BY kind",
    ).all(this.scope);
    return Object.fromEntries(rows.map(row => [row.kind, row.count]));
  }
  runCounts() {
    const rows = this.db.prepare<[string], { status: string; count: number }>(
      "SELECT status, count(*) AS count FROM runs WHERE scope=? GROUP BY status",
    ).all(this.scope);
    return Object.fromEntries(rows.map(row => [row.status, row.count]));
  }
  usedMemoryCount() {
    const rows = this.db.prepare<[string], { payload: string }>(
      "SELECT payload FROM events WHERE scope=? AND kind='usage'",
    ).all(this.scope);
    return rows.filter(row => {
      const usage = (JSON.parse(row.payload) as MemoryEvent).usage;
      return Boolean(usage?.hadMemory || usage?.trendIds.length || usage?.exampleIds.length);
    }).length;
  }
  // 本篇未形成长期倾向的正文修改，也可即时供上游参考；读取当前专题真实用户事件。
  recentBodyEdits(projectId: string): MemoryEvent[] {
    const rows = this.db.prepare<[string, string], { payload: string }>(
      "SELECT payload FROM events WHERE scope=? AND project_id=? AND kind IN ('manual','feedback') ORDER BY seq DESC LIMIT 60",
    ).all(this.scope, projectId);
    return rows.map(row => JSON.parse(row.payload) as MemoryEvent)
      .filter(event => event.stage === "article" && event.operation === "stage").slice(0, 6);
  }
  trends(): Trend[] {
    const rows = this.db.prepare<[string], { payload: string }>("SELECT payload FROM trends WHERE scope=? ORDER BY rowid").all(this.scope);
    return rows.map(row => {
      const trend = JSON.parse(row.payload) as Trend;
      const evidence = this.db.prepare<[string], { eventId: string; relation: "support" | "oppose" | "revision"; quote: string; explicit: number; resolved: number }>(
        "SELECT event_id AS eventId, relation, quote, explicit, resolved FROM evidence WHERE trend_id=?").all(trend.id);
      const normalizedEvidence = evidence.map(e => ({ ...e, explicit: Boolean(e.explicit), resolved: Boolean(e.resolved) }));
      const supportProjectCount = new Set(this.events(normalizedEvidence
        .filter(item => item.relation === "support").map(item => item.eventId)).map(event => event.projectId)).size;
      return { ...trend, supportProjectCount, evidence: normalizedEvidence };
    });
  }
  latestVersion(): number | null {
    return this.db.prepare<[string], { id: number }>("SELECT id FROM versions WHERE scope=? ORDER BY id DESC LIMIT 1").get(this.scope)?.id ?? null;
  }
  private snapshot(reason: string) {
    this.db.prepare("INSERT INTO versions(scope,created_at,reason,payload) VALUES (?,?,?,?)")
      .run(this.scope, new Date().toISOString(), reason, JSON.stringify(this.trends()));
  }
  private putTrend(trend: Trend) {
    // 倾向正文与证据分表；画像版本保留当时的完整快照。
    this.db.prepare("INSERT INTO trends(id,scope,identity,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET identity=excluded.identity,payload=excluded.payload")
      .run(trend.id, this.scope, `${trend.stage}/${trend.operation}/${identity(trend.text)}`, JSON.stringify({ ...trend, evidence: [] }));
  }
  private cursor() {
    return this.db.prepare<[string], { cursor: number }>("SELECT cursor FROM state WHERE scope=?").get(this.scope)!.cursor;
  }
  view(): MemoryView {
    const versions = this.db.prepare<[string], { id: number; createdAt: string; reason: string; payload: string }>(
      "SELECT id,created_at AS createdAt,reason,payload FROM versions WHERE scope=? ORDER BY id DESC LIMIT 30").all(this.scope)
      .map(({ payload, ...row }): MemoryVersion => ({ ...row, trends: JSON.parse(payload) }));
    const runs = this.db.prepare<[string], SummaryRun>(`SELECT id,mode,day,started_at AS startedAt,finished_at AS finishedAt,
      status,error,through_seq AS throughSeq FROM runs WHERE scope=? ORDER BY rowid DESC LIMIT 20`).all(this.scope);
    const pendingCount = this.db.prepare<[string, number], { n: number }>("SELECT count(*) AS n FROM events WHERE scope=? AND seq>? AND kind IN ('manual','feedback')").get(this.scope, this.cursor())!.n;
    const lastSuccess = this.db.prepare<[string], { finishedAt: string }>("SELECT finished_at AS finishedAt FROM runs WHERE scope=? AND status='succeeded' ORDER BY rowid DESC LIMIT 1").get(this.scope)?.finishedAt ?? null;
    return { trends: this.trends(), versions, runs, pendingCount, lastSuccess, events: [] };
  }
  claim(mode: "auto" | "manual", now = new Date()): SummaryBatch | string {
    return this.db.transaction(() => {
      const time = now.toISOString();
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      this.db.prepare("UPDATE runs SET status='failed',error='总结超时或进程中断，可重试',finished_at=? WHERE scope=? AND status='running' AND started_at<?")
        .run(time, this.scope, new Date(now.getTime() - LEASE_MS).toISOString());
      if (this.db.prepare("SELECT 1 FROM runs WHERE scope=? AND status='running'").get(this.scope)) return "已有风格总结正在进行，本次使用现有画像。";
      if (mode === "auto" && this.db.prepare("SELECT 1 FROM runs WHERE scope=? AND day=? AND (mode='auto' OR status='succeeded')").get(this.scope, day))
        return "今天已尝试更新风格，本次使用现有画像。";
      const rows = this.db.prepare<[string, number], EventRow>("SELECT seq,payload FROM events WHERE scope=? AND seq>? AND kind IN ('manual','feedback') ORDER BY seq LIMIT 30")
        .all(this.scope, this.cursor());
      const events: MemoryEvent[] = [];
      let throughSeq = this.cursor();
      let chars = 0;
      let throughOffset = this.db.prepare<[string], { offset: number }>("SELECT cursor_offset AS offset FROM state WHERE scope=?").get(this.scope)!.offset;
      for (const row of rows) {
        const original = JSON.parse(row.payload) as MemoryEvent;
        let event = original;
        // 模型输出只留作追溯，绝不进入偏好提炼材料。
        if (!["manual", "feedback"].includes(event.kind)) { throughSeq = row.seq; throughOffset = 0; continue; }
        // 超长修改逐段处理，原文仍完整保存在事件表；游标包含段偏移，未读部分留待后续。
        const window = 10000;
        const offset = throughOffset;
        const remaining = Math.max(event.before.length, event.after.length) > offset + window;
        event = { ...event, before: event.before.slice(offset, offset + window), after: event.after.slice(offset, offset + window),
          title: event.title.slice(0, 500), direction: event.direction.slice(0, 1000) };
        const size = JSON.stringify(event).length;
        if (events.length && (events.length >= BATCH_EVENTS || chars + size > BATCH_CHARS)) break;
        events.push(event); chars += size;
        if (remaining) { throughSeq = row.seq - 1; throughOffset = offset + window; break; }
        throughSeq = row.seq; throughOffset = 0;
        if (chars >= BATCH_CHARS) break;
      }
      if (!events.length) {
        this.db.prepare("UPDATE state SET cursor=?,cursor_offset=0 WHERE scope=?").run(throughSeq, this.scope);
        return "暂无新增修改需要总结。";
      }
      const batch: SummaryBatch = { runId: crypto.randomUUID(), baseVersion: this.latestVersion(), throughSeq, throughOffset, events, trends: this.trends() };
      this.db.prepare("INSERT INTO runs(id,scope,mode,day,started_at,status,through_seq,through_offset,base_version) VALUES (?,?,?,?,?,'running',?,?,?)")
        .run(batch.runId, this.scope, mode, day, time, throughSeq, throughOffset, batch.baseVersion);
      return batch;
    }).immediate();
  }
  fail(runId: string, message: string) {
    this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error=? WHERE id=? AND scope=? AND status='running'")
      .run(new Date().toISOString(), message.slice(0, 500), runId, this.scope);
  }
  complete(batch: SummaryBatch, value: SummaryResult) {
    const result = summarySchema.parse(value);
    this.db.transaction(() => {
      const run = this.db.prepare("SELECT 1 FROM runs WHERE id=? AND scope=? AND status='running'").get(batch.runId, this.scope);
      if (!run) throw new Error("本次总结已过期，请重新执行。");
      if (this.latestVersion() !== batch.baseVersion) throw new Error("总结期间画像已被修改，本批修改将在下次重新整理。");
      const allowed = new Map(batch.events.map(e => [e.id, e]));
      for (const trend of batch.trends) for (const event of this.events(trend.evidence.map(e => e.eventId))) allowed.set(event.id, event);
      for (const change of result.changes) {
        if (this.db.prepare("SELECT 1 FROM suppressed_styles WHERE scope=? AND identity=?")
          .get(this.scope, suppressionKey(change))) continue;
        let trends = this.trends();
        let trend = change.existingId ? trends.find(t => t.id === change.existingId) :
          trends.find(t => t.stage === change.stage && t.operation === change.operation &&
            t.scene === change.scene && identity(t.text) === identity(change.text));
        if (change.existingId && !trend) throw new Error("总结引用了不存在的倾向。");
        if (trend?.status === "disabled") continue;
        if (!trend && change.evidence.some(e => trends.some(t => t.status === "disabled" && t.evidence.some(old => old.eventId === e.eventId)))) continue;
        if (trend && (trend.stage !== change.stage || trend.operation !== change.operation)) throw new Error("不能将既有证据迁移到其他阶段。");
        trend ??= { id: crypto.randomUUID(), text: change.text, stage: change.stage, operation: change.operation,
          scene: change.scene, status: "observing", userEdited: false, updatedAt: new Date().toISOString(), evidence: [] };
        // 已有倾向的含义保持稳定；自动总结只累积证据，改写含义由用户明确修订。
        this.putTrend(trend);
        const canSupportTrend = (event: MemoryEvent) => {
          // 正文证据可指导选题、方向和大纲；事件原始阶段不变，倾向阶段表示使用位置。
          const bodyReference = event.stage === "article" && event.operation === "stage" &&
            (trend!.stage === "topics" || (trend!.stage === "outline" && trend!.operation === "stage"));
          return ["manual", "feedback"].includes(event.kind) &&
            (bodyReference || (event.stage === trend!.stage && event.operation === trend!.operation));
        };
        const visibleText = (event: MemoryEvent) => event.kind === "feedback" ? event.instruction : `${event.before}\n${event.after}`;
        const resolvedEvidence = change.evidence.map(item => {
          const direct = allowed.get(item.eventId);
          // 模型可能在合并会话中保留了原文，却把 eventId 贴到了同会话的另一事件；按原文唯一归属修正。
          const event = [direct, ...allowed.values()]
            .filter((candidate, index, all): candidate is MemoryEvent => Boolean(candidate) && all.indexOf(candidate) === index)
            .find(candidate => canSupportTrend(candidate) && visibleText(candidate).includes(item.quote));
          return { item, event, reason: !event && direct && canSupportTrend(direct) ? "quote" as const : "source" as const };
        });
        if (resolvedEvidence.some(item => item.reason === "quote")) throw new Error("证据引用不是用户修改中的原文。");
        if (!resolvedEvidence.every(item => item.event)) {
          const failed = resolvedEvidence.find(item => !item.event)!;
          const source = allowed.get(failed.item.eventId);
          const sourceLabel = source ? `${source.stage}/${source.operation}` : "不存在";
          throw new Error(`证据来源或适用阶段不匹配：倾向 ${trend.stage}/${trend.operation}，事件 ${sourceLabel}，eventId=${failed.item.eventId}`);
        }
        if (!resolvedEvidence.some(({ event }) => event && batch.events.some(candidate => candidate.id === event.id)))
          throw new Error("倾向更新必须关联本批新增修改。");
        for (const { item, event } of resolvedEvidence) {
          if (!event) throw new Error("倾向证据来源不可用。");
          // 正文证据可指导选题、方向和大纲；事件原始阶段不变，倾向阶段表示使用位置。
          // 长期偏好必须有直接原话；仅模型声称 explicit 不足以越过三篇门槛。
          const explicit = item.explicit && event.kind === "feedback" && /以后|今后|始终|一直|长期|每次|记住|通常|一贯|偏好/.test(item.quote);
          this.db.prepare("INSERT OR IGNORE INTO evidence(trend_id,event_id,relation,quote,explicit) VALUES (?,?,?,?,?)")
            .run(trend.id, event.id, item.relation, item.quote, Number(explicit));
        }
        trends = this.trends();
        trend = trends.find(t => t.id === trend!.id)!;
        const support = trend.evidence.filter(e => e.relation !== "oppose");
        const projects = new Set(this.events(support.map(e => e.eventId)).map(e => e.projectId));
        trend.status = trend.evidence.some(e => e.relation === "oppose" && !e.resolved) ? "conflicted" :
          trend.userEdited || support.some(e => e.explicit) || projects.size >= SUPPORT_PROJECTS ? "active" : "observing";
        trend.updatedAt = new Date().toISOString();
        this.putTrend(trend);
      }
      this.snapshot("总结近期修改");
      this.db.prepare("UPDATE state SET cursor=?,cursor_offset=? WHERE scope=?").run(batch.throughSeq, batch.throughOffset, this.scope);
      this.db.prepare("UPDATE runs SET status='succeeded',finished_at=? WHERE id=?").run(new Date().toISOString(), batch.runId);
    }).immediate();
  }
  manage(id: string, action: "correct" | "disable" | "restore", text?: string) {
    this.db.transaction(() => {
      const trend = this.trends().find(t => t.id === id);
      if (!trend) throw new Error("风格倾向不存在。");
      if (action === "correct") {
        if (!text?.trim()) throw new Error("请填写修订后的倾向。");
        const event: MemoryEvent = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), projectId: "00000000-0000-4000-8000-000000000000",
          topicId: this.topicId, kind: "correction", target: trend.id, before: trend.text, after: text.trim(), instruction: text.trim(),
          stage: trend.stage, operation: trend.operation, title: "用户修订风格", direction: "" };
        this.ingest([event]);
        this.db.prepare("UPDATE evidence SET resolved=1 WHERE trend_id=? AND relation='oppose'").run(id);
        this.db.prepare("INSERT INTO evidence(trend_id,event_id,relation,quote,explicit) VALUES (?,?,'revision',?,1)").run(id, event.id, event.after);
        trend.text = event.after; trend.userEdited = true;
        if (trend.status !== "disabled") trend.status = "active";
      } else if (action === "disable") trend.status = "disabled";
      else {
        // 恢复只解除用户停用；没有足够证据时仍处于观察，有反例时仍暂停。
        const support = trend.evidence.filter(e => e.relation !== "oppose");
        const count = new Set(this.events(support.map(e => e.eventId)).map(e => e.projectId)).size;
        trend.status = trend.evidence.some(e => e.relation === "oppose" && !e.resolved) ? "conflicted" :
          trend.userEdited || support.some(e => e.explicit) || count >= SUPPORT_PROJECTS ? "active" : "observing";
      }
      trend.updatedAt = new Date().toISOString();
      this.putTrend(trend);
      this.snapshot({ correct: "用户修订", disable: "用户停用", restore: "用户恢复" }[action]);
    }).immediate();
  }
}

// 连接仅存在于服务端；主库纳入 Git，临时 journal/WAL/SHM 文件仍忽略。
const globalMemory = globalThis as typeof globalThis & { articleStyleStores?: Map<MemoryTopic, StyleMemoryStore> };
export function memoryStore(topicId: MemoryTopic): StyleMemoryStore {
  const stores = globalMemory.articleStyleStores ??= new Map<MemoryTopic, StyleMemoryStore>();
  let store = stores.get(topicId);
  // 开发态热更新会保留 globalThis；更新原型，避免旧闭包继续使用旧删除规则。
  if (store) Object.setPrototypeOf(store, StyleMemoryStore.prototype);
  // 迁移数据库后替换旧连接，正常请求仍复用文章数据库。
  // 仅在能力缺失时替换连接，正常请求仍复用同一个 SQLite 连接。
  if (store && (typeof store.projectEvents !== "function" || typeof store.eventCounts !== "function" ||
    typeof store.runCounts !== "function" || typeof store.usedMemoryCount !== "function" ||
    store.db !== articleDatabase().db || typeof store.deleteProjectEvidence !== "function")) {
    if (store.db !== articleDatabase().db && store.db.open) store.close();
    stores.delete(topicId);
    store = undefined;
  }
  if (!store) {
    store = new StyleMemoryStore(articleDatabase().db, topicId);
    stores.set(topicId, store);
  }
  return store;
}
