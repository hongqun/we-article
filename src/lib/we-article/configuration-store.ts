import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ArticleSelection, ConfigurationDraft, ConfigurationSession, ConfigurationSource,
  WritingAccount, WritingConfiguration, WritingTopic } from "./types";
import { ArticleError } from "./validation";

const accountColumns = "id,name,content,created_at AS createdAt,updated_at AS updatedAt";
type TopicRow = WritingAccount & { accountId: string; sources: string };

// 与文章共用独立库，配置对话和提炼来源单独保存。
export class ConfigurationStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS writing_accounts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS writing_topics (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES writing_accounts(id),
        name TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS configuration_sessions (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
  }
  account(id: string): WritingAccount {
    const row = this.db.prepare(`SELECT ${accountColumns} FROM writing_accounts WHERE id=?`).get(id) as WritingAccount | undefined;
    if (!row) throw new ArticleError("账号不存在。", 404);
    return row;
  }
  topic(id: string): WritingTopic {
    const row = this.db.prepare(`SELECT ${accountColumns},account_id AS accountId,sources FROM writing_topics WHERE id=?`).get(id) as TopicRow | undefined;
    if (!row) throw new ArticleError("专题不存在。", 404);
    return { ...row, sources: JSON.parse(row.sources) };
  }
  list(): WritingConfiguration {
    const accounts = this.db.prepare(`SELECT ${accountColumns} FROM writing_accounts ORDER BY created_at,id`).all() as WritingAccount[];
    const rows = this.db.prepare(`SELECT ${accountColumns},account_id AS accountId,sources FROM writing_topics ORDER BY created_at,id`).all() as TopicRow[];
    const sessions = (this.db.prepare("SELECT state FROM configuration_sessions ORDER BY updated_at DESC,id").all() as { state: string }[])
      .map(row => JSON.parse(row.state) as ConfigurationSession).filter(session => !session.confirmedId)
      .map(({ id, kind, draft, updatedAt }) => ({ id, kind, name: draft.name, updatedAt }));
    return { accounts, topics: rows.map(row => ({ ...row, sources: JSON.parse(row.sources) })), sessions };
  }
  validateSelection(selection: ArticleSelection) {
    this.context(selection);
    return selection;
  }
  // 每轮读取最新配置；未选择时不会增加写作上下文。
  context(selection: ArticleSelection) {
    const account = selection.accountId ? this.account(selection.accountId) : null;
    const topic = selection.topicId ? this.topic(selection.topicId) : null;
    if (topic && topic.accountId !== account?.id) throw new ArticleError("请选择所属账号下的专题。", 400);
    return { account, topic };
  }
  session(id: string): ConfigurationSession {
    const row = this.db.prepare("SELECT state FROM configuration_sessions WHERE id=?").get(id) as { state: string } | undefined;
    if (!row) throw new ArticleError("配置草稿不存在。", 404);
    return JSON.parse(row.state);
  }
  private put(session: ConfigurationSession) {
    session.updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO configuration_sessions(id,state,updated_at) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(session.id, JSON.stringify(session), session.updatedAt);
    return session;
  }
  createSession(input: { kind: "account" | "topic"; accountId: string | null; targetId: string | null }, sources: ConfigurationSource[]) {
    if (input.kind === "account" && sources.length) throw new ArticleError("文章提炼用于创建专题。", 400);
    const target = input.targetId ? (input.kind === "account" ? this.account(input.targetId) : this.topic(input.targetId)) : null;
    const accountId = input.kind === "topic" && target ? (target as WritingTopic).accountId : input.accountId;
    if (accountId) this.account(accountId);
    const savedSources = target && input.kind === "topic" ? (target as WritingTopic).sources : sources;
    return this.put({ id: randomUUID(), kind: input.kind, accountId: input.kind === "account" ? null : accountId,
      targetId: input.targetId, confirmedId: null, draft: { name: target?.name ?? "", content: target?.content ?? "" },
      messages: [], sources: savedSources, updatedAt: "" });
  }
  editSession(id: string, draft: ConfigurationDraft, accountId: string | null) {
    const session = this.session(id);
    if (session.confirmedId) throw new ArticleError("配置已保存，请重新打开编辑。", 409);
    if (accountId) this.account(accountId);
    if (session.kind === "topic" && session.targetId && this.topic(session.targetId).accountId !== accountId)
      throw new ArticleError("编辑专题时不能更换所属账号。", 400);
    session.draft = draft;
    session.accountId = session.kind === "account" ? null : accountId;
    return this.put(session);
  }
  addMessage(id: string, role: "user" | "assistant", content: string, draft?: ConfigurationDraft) {
    const session = this.session(id);
    if (session.confirmedId) throw new ArticleError("配置已保存，请重新打开编辑。", 409);
    session.messages.push({ role, content });
    if (draft) session.draft = draft;
    return this.put(session);
  }
  confirm(id: string, draft: ConfigurationDraft, accountId: string | null): WritingAccount | WritingTopic {
    return this.db.transaction(() => {
      const existing = this.session(id);
      if (existing.confirmedId) return existing.kind === "account" ? this.account(existing.confirmedId) : this.topic(existing.confirmedId);
      if (!draft.name.trim() || !draft.content.trim()) throw new ArticleError("请先补充配置名称和写作要求。", 400);
      const session = this.editSession(id, { name: draft.name.trim(), content: draft.content.trim() }, accountId);
      if (session.kind === "topic" && !accountId) throw new ArticleError("请选择专题所属账号。", 400);
      const targetId = session.targetId ?? randomUUID(), now = new Date().toISOString();
      if (session.kind === "account") {
        this.db.prepare(`INSERT INTO writing_accounts(id,name,content,created_at,updated_at) VALUES (?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,content=excluded.content,updated_at=excluded.updated_at`)
          .run(targetId, session.draft.name, session.draft.content, now, now);
      } else {
        this.db.prepare(`INSERT INTO writing_topics(id,account_id,name,content,sources,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,content=excluded.content,sources=excluded.sources,updated_at=excluded.updated_at`)
          .run(targetId, accountId, session.draft.name, session.draft.content, JSON.stringify(session.sources), now, now);
      }
      session.confirmedId = targetId;
      this.put(session);
      return session.kind === "account" ? this.account(targetId) : this.topic(targetId);
    }).immediate();
  }
}
