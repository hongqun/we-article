import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Article, ArticleSummary, Message, Source } from "./types";
import { ArticleError } from "./validation";

type Row = ArticleSummary & { body: string };
const columns = `id,title,body,created_at AS createdAt,updated_at AS updatedAt`;

// 文章和对话保存在独立数据库中。
export class WritingStore {
  private readonly db: Database.Database;
  constructor(filename = path.join(process.cwd(), "data", "we-article.db")) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_article ON messages(article_id,ordinal);
    `);
    // 在现有消息中标记网页素材，旧消息保持普通对话。
    const messageColumns = (this.db.pragma("table_info(messages)") as { name: string }[]).map(column => column.name);
    if (!messageColumns.includes("source_url")) this.db.exec("ALTER TABLE messages ADD COLUMN source_url TEXT");
    // 旧库移除不再使用的并发控制字段，保留文章与对话。
    const names = (this.db.pragma("table_info(articles)") as { name: string }[]).map(column => column.name);
    this.db.transaction(() => {
      for (const name of ["run_token", "run_until", "revision"]) {
        if (names.includes(name)) this.db.exec(`ALTER TABLE articles DROP COLUMN ${name}`);
      }
    })();
  }
  list(): ArticleSummary[] {
    return this.db.prepare(`SELECT id,title,created_at AS createdAt,updated_at AS updatedAt
      FROM articles ORDER BY updated_at DESC,id`).all() as ArticleSummary[];
  }
  private row(id: string): Row {
    const row = this.db.prepare(`SELECT ${columns} FROM articles WHERE id=?`).get(id) as Row | undefined;
    if (!row) throw new ArticleError("文章不存在。", 404);
    return row;
  }
  read(id: string): Article {
    return this.db.transaction(() => {
      const row = this.row(id);
      const messages = this.db.prepare(`SELECT id,role,content,created_at AS createdAt,source_url AS sourceUrl
        FROM messages WHERE article_id=? ORDER BY ordinal`).all(id) as Message[];
      return { ...row, messages };
    })();
  }
  create(): Article {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare(`INSERT INTO articles(id,title,body,created_at,updated_at)
      VALUES (?,'未命名文章','',?,?)`).run(id, now, now);
    return this.read(id);
  }
  save(id: string, draft: { title: string; body: string }): Article {
    return this.db.transaction(() => {
      this.row(id);
      this.db.prepare(`UPDATE articles SET title=?,body=?,updated_at=? WHERE id=?`)
        .run(draft.title || "未命名文章", draft.body, new Date().toISOString(), id);
      return this.read(id);
    }).immediate();
  }
  begin(id: string, instruction: string) {
    return this.db.transaction(() => {
      this.row(id);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE articles SET updated_at=? WHERE id=?`).run(now, id);
      this.db.prepare(`INSERT INTO messages(id,article_id,role,content,created_at) VALUES (?,?,'user',?,?)`)
        .run(randomUUID(), id, instruction, now);
      return this.read(id);
    }).immediate();
  }
  finish(id: string, draft: { title: string; body: string }, reply: string, sources: Source[]) {
    return this.db.transaction(() => {
      this.row(id);
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE articles SET title=?,body=?,updated_at=? WHERE id=?`).run(draft.title, draft.body, now, id);
      const insertSource = this.db.prepare(`INSERT INTO messages(id,article_id,role,content,created_at,source_url) VALUES (?,?,'assistant',?,?,?)`);
      for (const source of sources) insertSource.run(randomUUID(), id, source.content, source.createdAt, source.url);
      this.db.prepare(`INSERT INTO messages(id,article_id,role,content,created_at) VALUES (?,?,'assistant',?,?)`)
        .run(randomUUID(), id, reply, now);
      return this.read(id);
    }).immediate();
  }
  // 只修改当前文章中的助手回复，保留消息顺序和创建时间。
  updateMessage(id: string, messageId: string, content: string): Article {
    return this.db.transaction(() => {
      this.row(id);
      const result = this.db.prepare(`UPDATE messages SET content=? WHERE id=? AND article_id=? AND role='assistant' AND source_url IS NULL`)
        .run(content, messageId, id);
      if (!result.changes) throw new ArticleError("助手消息不存在。", 404);
      this.db.prepare(`UPDATE articles SET updated_at=? WHERE id=?`).run(new Date().toISOString(), id);
      return this.read(id);
    }).immediate();
  }
}
let store: WritingStore | undefined;
export function writingStore() { return store ??= new WritingStore(); }
