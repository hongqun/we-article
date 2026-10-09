import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleDatabase } from "../lib/database";
import { newProject } from "../lib/project";
import { makeEvent } from "../lib/style-memory/events";
import { StyleMemoryStore, type SummaryBatch } from "../lib/style-memory/store";

// 仅使用临时目录；验证迁移原文、级联删除及失败回滚，不接触真实文章库。
test("旧风格库及文章全部版本迁入一次，删除后重启不会复活", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "article-migration-"));
  let database: ArticleDatabase | undefined;
  try {
    const project = newProject("jianxi");
    project.results.article = "人工最终正文";
    project.articleVersions = [{ id: crypto.randomUUID(), content: "模型初稿", createdAt: project.updatedAt,
      source: "generation", summary: "初稿" }, { id: crypto.randomUUID(), content: "人工最终正文", createdAt: project.updatedAt,
      source: "manual", summary: "人工修改" }];
    const event = makeEvent(project, { kind: "manual", target: "article", before: "模型初稿", after: "人工最终正文" });
    const legacy = new StyleMemoryStore(path.join(directory, "style-memory.sqlite"), "jianxi");
    legacy.ingest([event]); legacy.close();
    mkdirSync(path.join(directory, "projects"));
    const filename = path.join(directory, "projects", `${project.id}.json`);
    writeFileSync(filename, JSON.stringify(project));
    database = new ArticleDatabase(directory);
    assert.deepEqual(database.read(project.id), project);
    assert.equal(existsSync(filename), false);
    assert.deepEqual(database.db.prepare("SELECT count(*) AS n FROM article_versions").get(), { n: 2 });
    const store = new StyleMemoryStore(database.db, "jianxi");
    assert.equal(store.events([event.id]).length, 1);
    database.remove(project.id, () => store.deleteProjectEvidence(project.id));
    assert.equal(database.ids().length, 0);
    assert.equal(store.events([event.id]).length, 0);
    assert.throws(() => database!.write(project), /已删除/);
    database.db.close(); database = new ArticleDatabase(directory);
    assert.deepEqual(database.ids(), []);
    assert.deepEqual(database.db.pragma("foreign_key_check"), []);
  } finally { database?.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("整批迁移遇到损坏文件时不删除原始文件", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "article-invalid-migration-"));
  try {
    mkdirSync(path.join(directory, "projects"));
    const project = newProject("jianxi");
    const filename = path.join(directory, "projects", `${project.id}.json`);
    writeFileSync(filename, JSON.stringify(project));
    writeFileSync(path.join(directory, "projects", "broken.json"), "{");
    assert.throws(() => new ArticleDatabase(directory));
    assert.equal(existsSync(filename), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("删除事务回滚保护正文；成功删除撤回引用并阻止在途总结提交", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "article-delete-"));
  const database = new ArticleDatabase(directory);
  try {
    const store = new StyleMemoryStore(database.db, "jianxi");
    const first = newProject("jianxi"); const second = newProject("jianxi");
    database.write(first); database.write(second);
    const event = makeEvent(first, { kind: "feedback", stage: "article", target: "article", before: "", after: "",
      instruction: "以后结尾使用具体行动" });
    store.ingest([event]);
    const batch = store.claim("manual") as SummaryBatch;
    store.complete(batch, { changes: [{ existingId: null, text: "结尾使用具体行动", scene: "结尾", stage: "article", operation: "stage",
      evidence: [{ eventId: event.id, relation: "support", quote: event.instruction, explicit: true }] }] });
    const trendId = store.trends()[0].id;
    const usage = makeEvent(second, { kind: "usage", stage: "article", target: "article", before: "", after: "",
      usage: { versionId: store.latestVersion(), trendIds: [trendId], exampleIds: [event.id], context: event.instruction } });
    store.ingest([usage]);
    store.ingest([makeEvent(second, { kind: "manual", target: "article", before: "旧", after: "新" })]);
    const pending = store.claim("manual") as SummaryBatch;
    assert.throws(() => database.remove(first.id, () => { store.deleteProjectEvidence(first.id); throw new Error("清理失败"); }), /清理失败/);
    assert.equal(database.read(first.id).id, first.id);
    assert.equal(store.trends().length, 1);
    database.remove(first.id, () => store.deleteProjectEvidence(first.id));
    assert.equal(store.trends().length, 0);
    assert.equal(store.events([event.id]).length, 0);
    assert.equal(store.events([usage.id])[0].usage?.context, "");
    assert.equal(store.events([usage.id])[0].usage?.redacted, true);
    assert.equal(store.view().versions.some(version => version.trends.some(trend => trend.id === trendId)), false);
    assert.throws(() => store.complete(pending, { changes: [] }), /过期/);
    assert.equal(store.view().pendingCount, 1);
    assert.equal(database.read(second.id).id, second.id);
  } finally { database.db.close(); rmSync(directory, { recursive: true, force: true }); }
});
