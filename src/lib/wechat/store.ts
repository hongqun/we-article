import type Database from "better-sqlite3";
import { articleDatabase } from "../database";

export type DraftRow = { account: string; project_id: string; topic_id: string; media_id: string | null;
  fingerprint: string | null; article_index: number; theme: string; updated_at: string };
export type Attempt = { id: string; account: string; project_id: string | null; state: string;
  payload: string; media_id: string | null; error: string | null; created_at: string };
export type FetchRow = { account: string; source: string; date: string; state: string; fetched_at: string | null;
  error: string | null; retry_at: string; attempts: number };
// 微信数据独立建表，不产生风格学习证据；删除项目仅解除关联。
export class WechatStore {
  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wx_preferences(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, theme TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wx_drafts(account TEXT NOT NULL, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        topic_id TEXT NOT NULL, media_id TEXT, fingerprint TEXT, theme TEXT NOT NULL, updated_at TEXT NOT NULL, article_index INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account,project_id,topic_id));
      CREATE TABLE IF NOT EXISTS wx_attempts(id TEXT PRIMARY KEY,account TEXT NOT NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        state TEXT NOT NULL,payload TEXT NOT NULL,media_id TEXT,error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wx_leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wx_fetches(account TEXT NOT NULL,source TEXT NOT NULL,date TEXT NOT NULL,state TEXT NOT NULL,
        fetched_at TEXT,error TEXT,retry_at TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(account,source,date));
      CREATE TABLE IF NOT EXISTS wx_source_status(account TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,error TEXT,
        updated_at TEXT NOT NULL,PRIMARY KEY(account,source));
      CREATE TABLE IF NOT EXISTS wx_raw(account TEXT NOT NULL,source TEXT NOT NULL,date TEXT NOT NULL,payload TEXT NOT NULL,
        fetched_at TEXT NOT NULL,PRIMARY KEY(account,source,date));
      CREATE TABLE IF NOT EXISTS wx_daily(account TEXT NOT NULL,article_id TEXT NOT NULL,date TEXT NOT NULL,source TEXT NOT NULL,
        payload TEXT NOT NULL,PRIMARY KEY(account,article_id,date,source));
      CREATE TABLE IF NOT EXISTS wx_articles(account TEXT NOT NULL,msgid TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,
        published_at TEXT NOT NULL,PRIMARY KEY(account,msgid));
      CREATE TABLE IF NOT EXISTS wx_totals(account TEXT NOT NULL,msgid TEXT NOT NULL,stat_date TEXT NOT NULL,payload TEXT NOT NULL,
        PRIMARY KEY(account,msgid,stat_date));
      CREATE TABLE IF NOT EXISTS wx_sync(account TEXT PRIMARY KEY,scheduled_day TEXT NOT NULL DEFAULT '',last_started TEXT,
        last_finished TEXT,error TEXT);
      CREATE INDEX IF NOT EXISTS wx_daily_dates ON wx_daily(account,date);
    `);
    // 开发热更新期间已有表同样补齐文章位置，不重建历史推送记录。
    const columns = db.prepare("PRAGMA table_info(wx_drafts)").all() as { name: string }[];
    if (!columns.some(column => column.name === "article_index")) db.exec("ALTER TABLE wx_drafts ADD COLUMN article_index INTEGER NOT NULL DEFAULT 0");
  }
  lease(name: string, owner: string, ttl = 120_000) {
    const now = Date.now();
    return this.db.prepare(`INSERT INTO wx_leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,
      expires_at=excluded.expires_at WHERE wx_leases.expires_at<? OR wx_leases.owner=?`).run(name, owner, now + ttl, now, owner).changes > 0;
  }
  release(name: string, owner: string) { this.db.prepare("DELETE FROM wx_leases WHERE name=? AND owner=?").run(name, owner); }
  draft(account: string, project: string, topic: string) {
    return this.db.prepare("SELECT * FROM wx_drafts WHERE account=? AND project_id=? AND topic_id=?").get(account, project, topic) as DraftRow | undefined;
  }
  attempt(id: string) { return this.db.prepare("SELECT * FROM wx_attempts WHERE id=?").get(id) as Attempt | undefined; }
  saveDraft(account: string, project: string, topic: string, mediaId: string, fingerprint: string, theme: string, index = 0) {
    this.db.prepare(`INSERT INTO wx_drafts(account,project_id,topic_id,media_id,fingerprint,theme,updated_at,article_index) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account,project_id,topic_id) DO UPDATE SET
      media_id=excluded.media_id,fingerprint=excluded.fingerprint,theme=excluded.theme,updated_at=excluded.updated_at,article_index=excluded.article_index`)
      .run(account, project, topic, mediaId, fingerprint, theme, new Date().toISOString(), index);
  }
}
const state = globalThis as typeof globalThis & { articleWechatStore?: WechatStore };
export function wechatStore() {
  const db = articleDatabase().db;
  if (!state.articleWechatStore || state.articleWechatStore.db !== db) state.articleWechatStore = new WechatStore(db);
  return state.articleWechatStore;
}
