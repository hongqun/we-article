import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectSchema, type Project } from "./project";

// 项目、版本和成稿分表保存；页面仍使用原有 Project 契约，不改变四阶段流程。
export class ArticleDatabase {
  readonly db: Database.Database;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, "article.sqlite");
    const legacy = path.join(directory, "style-memory.sqlite");
    if (!existsSync(filename) && existsSync(legacy)) {
      // 通过 SQLite 复制一致快照，兼容旧库可能存在的 WAL，不直接复制主文件。
      const source = new Database(legacy);
      try { source.prepare("VACUUM INTO ?").run(filename); } finally { source.close(); }
    }
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = DELETE");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS article_versions (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id, ordinal));
      CREATE TABLE IF NOT EXISTS finalizations (id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(project_id, ordinal));
      CREATE TABLE IF NOT EXISTS deleted_projects (id TEXT PRIMARY KEY, deleted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_imports (name TEXT PRIMARY KEY, digest TEXT NOT NULL);
    `);
    try { this.importLegacyProjects(); }
    catch (error) { this.db.close(); throw error; }
  }
  ids(): string[] {
    return this.db.prepare<[], { id: string }>("SELECT id FROM projects ORDER BY updated_at DESC").all().map(row => row.id);
  }
  read(id: string): Project {
    // 多张表来自同一个读取快照，不能把删除前项目与删除后版本拼在一起。
    return this.db.transaction(() => this.readSnapshot(id))();
  }
  private readSnapshot(id: string): Project {
    const row = this.db.prepare<[string], { payload: string }>("SELECT payload FROM projects WHERE id=?").get(id);
    if (!row) throw Object.assign(new Error("项目不存在或已删除。"), { code: "ENOENT" });
    const rows = (table: "article_versions" | "finalizations") => this.db
      .prepare<[string], { payload: string }>(`SELECT payload FROM ${table} WHERE project_id=? ORDER BY ordinal`)
      .all(id).map(item => JSON.parse(item.payload));
    return projectSchema.parse({ ...JSON.parse(row.payload), articleVersions: rows("article_versions"), finalizations: rows("finalizations") });
  }
  write(project: Project) {
    this.db.transaction(() => {
      // 墓碑阻止另一个标签页或在途模型请求重新创建已删除的文章。
      if (this.db.prepare("SELECT 1 FROM deleted_projects WHERE id=?").get(project.id))
        throw new Error("项目已删除，不能继续保存。请新建文章。");
      const { articleVersions, finalizations, ...payload } = project;
      this.db.prepare(`INSERT INTO projects(id,topic_id,updated_at,payload) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET topic_id=excluded.topic_id,updated_at=excluded.updated_at,payload=excluded.payload`)
        .run(project.id, project.topicId, project.updatedAt, JSON.stringify(payload));
      const version = this.db.prepare("INSERT INTO article_versions(id,project_id,ordinal,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING");
      articleVersions.forEach((item, ordinal) => version.run(item.id, project.id, ordinal, JSON.stringify(item)));
      const final = this.db.prepare(`INSERT INTO finalizations(id,project_id,ordinal,payload) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`);
      finalizations.forEach((item, ordinal) => final.run(item.id, project.id, ordinal, JSON.stringify(item)));
    })();
  }
  remove(id: string, removeEvidence: () => void) {
    // 证据清理失败时正文与版本也回滚，绝不留下半删除状态。
    this.db.transaction(() => {
      removeEvidence();
      this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
      this.db.prepare("INSERT OR IGNORE INTO deleted_projects(id,deleted_at) VALUES (?,?)").run(id, new Date().toISOString());
    }).immediate();
  }
  private importLegacyProjects() {
    const directory = path.join(this.directory, "projects");
    if (!existsSync(directory)) return;
    const names = readdirSync(directory).filter(name => name.endsWith(".json"));
    // 整批先解析，再事务入库；任何损坏文件都会阻止清理，原文不会丢失。
    const entries = names.map(name => {
      const content = readFileSync(path.join(directory, name), "utf8");
      const project = projectSchema.parse(JSON.parse(content));
      if (name !== `${project.id}.json`) throw new Error(`项目文件名与 ID 不一致：${name}`);
      return { name, content, project, digest: createHash("sha256").update(content).digest("hex") };
    });
    this.db.transaction(() => {
      for (const entry of entries) {
        const imported = this.db.prepare<[string], { digest: string }>("SELECT digest FROM legacy_imports WHERE name=?").get(entry.name);
        if (imported) {
          if (imported.digest !== entry.digest) throw new Error(`迁移后的旧文件又被修改，请停止旧服务后处理：${entry.name}`);
          continue;
        }
        if (this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(entry.project.id))
          throw new Error(`数据库与旧文件存在同名项目，未覆盖：${entry.name}`);
        this.write(entry.project);
        this.db.prepare("INSERT INTO legacy_imports(name,digest) VALUES (?,?)").run(entry.name, entry.digest);
      }
    }).immediate();
    // 提交成功后才清理旧 JSON；中断后凭迁移摘要重试，不重新导入被删除的项目。
    for (const entry of entries) {
      if (readFileSync(path.join(directory, entry.name), "utf8") !== entry.content)
        throw new Error(`旧项目在迁移期间被修改，已保留文件：${entry.name}`);
      unlinkSync(path.join(directory, entry.name));
    }
  }
}

const globalDatabase = globalThis as typeof globalThis & { articleDatabase?: ArticleDatabase };
export function articleDatabase(): ArticleDatabase {
  // 热更新时让已有连接使用新方法；不关闭仍被在途请求共享的连接。
  if (globalDatabase.articleDatabase) Object.setPrototypeOf(globalDatabase.articleDatabase, ArticleDatabase.prototype);
  return globalDatabase.articleDatabase ??= new ArticleDatabase(path.join(process.cwd(), "data"));
}
