import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleDatabase } from "../lib/database";
import { createArticleReferenceAccess } from "../lib/article-reference";
import { newProject, toProjectSummary, type Project } from "../lib/project";
import { applyAgentResult } from "../lib/agent";

// 所有查询使用临时库；真实文章、模型配置和网络均不参与测试。
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "article-reference-"));
  const db = new ArticleDatabase(directory);
  const current = newProject("jianxi");
  db.write(current);
  const filename = path.join(directory, "article.sqlite");
  const messages: string[] = [];
  const access = () => createArticleReferenceAccess(current, message => messages.push(message), filename);
  const add = (title: string, topicId = current.topicId, content = `# ${title}\n\n参考正文`) => {
    const project = newProject("jianxi");
    project.topicId = topicId; project.results.article = content; project.selectedTopic = `选题-${title}`;
    db.write(project);
    return project;
  };
  return { db, current, filename, access, add, messages,
    close: () => { db.db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("完整标题优先，兼容选题和显示名称，搜索不泄漏全文且读库不产生写入", async () => {
  const f = fixture();
  try {
    const target = f.add("理解 Agent");
    f.add("理解 Agent 的工具");
    const before = readFileSync(f.filename);
    for (const query of ["理解 Agent", target.selectedTopic, toProjectSummary(target).title, target.id]) {
      const access = f.access();
      const result = await access.tools[0].invoke({ query });
      assert.equal(result.selectedId, target.id);
      assert.equal(JSON.stringify(result).includes("参考正文"), false);
      assert.throws(() => access.assertComplete(), /尚未读取/);
      const read = await access.tools[1].invoke({ id: target.id });
      assert.equal(read.content, target.results.article);
      access.assertComplete();
    }
    assert.deepEqual(readFileSync(f.filename), before);
    assert.ok(f.messages.some(message => message.includes("已读取《理解 Agent》·最新保存版")));
  } finally { f.close(); }
});

test("四阶段均可按部分标题读取多篇，默认隔离专题，明确跨专题或全库可查", async () => {
  const f = fixture();
  try {
    const a = f.add("工具调用详解");
    const b = f.add("上下文管理详解");
    const otherTopic = f.current.topicId === "jianxi" ? "tech123" : "jianxi";
    const cross = f.add("跨专题文章", otherTopic);
    for (const stage of ["analysis", "topics", "outline", "article"] as const) {
      f.current.stage = stage;
      const access = f.access();
      await access.tools[0].invoke({ query: "工具调用" });
      await access.tools[0].invoke({ query: "上下文管理" });
      await access.tools[1].invoke({ id: a.id });
      assert.throws(() => access.assertComplete(), /尚未读取/);
      await access.tools[1].invoke({ id: b.id });
      access.assertComplete();
    }
    assert.equal((await f.access().tools[0].invoke({ query: "跨专题文章" })).status, "not_found");
    for (const scope of [otherTopic, "all"] as ("jianxi" | "tech123" | "all")[]) {
      const access = f.access();
      assert.equal((await access.tools[0].invoke({ query: "跨专题文章", scope })).selectedId, cross.id);
      await access.tools[1].invoke({ id: cross.id });
      access.assertComplete();
    }
    assert.equal((await f.access().tools[0].invoke({ query: f.current.id, scope: "all" })).status, "not_found");
  } finally { f.close(); }
});

test("同名和大量匹配要求补充 ID，候选最多十条；新请求可按 ID 消歧", async () => {
  const f = fixture();
  try {
    const target = f.add("同名文章"); f.add("同名文章");
    await assert.rejects(f.access().tools[0].invoke({ query: "同名文章" }), /多个匹配.*补充/s);
    for (let index = 0; index < 12; index++) f.add(`系列文章-${index}`);
    await assert.rejects(f.access().tools[0].invoke({ query: "系列文章" }), error => {
      assert.equal(((error as Error).message.match(/ID:/g) || []).length, 10);
      assert.match((error as Error).message, /还有更多/);
      return true;
    });
    const access = f.access();
    assert.equal((await access.tools[0].invoke({ query: target.id })).selectedId, target.id);
    await access.tools[1].invoke({ id: target.id });
    access.assertComplete();
  } finally { f.close(); }
});

function finalize(project: Project, content: string, date: string, status: "completed" | "failed" = "completed") {
  const id = crypto.randomUUID();
  project.articleVersions.push({ id, content, source: "manual", summary: "保存", createdAt: date, topicId: project.topicId });
  project.finalizations.push({ id: crypto.randomUUID(), articleVersionId: id, createdAt: date, topicId: project.topicId,
    status, originalOutline: "", revisedOutline: null, structuralChange: false, reason: "", feedbackCount: 0,
    manualEdited: false, styleUsed: false });
  return id;
}

test("最新正文与定稿明确分开，只读最近成功且同专题成稿，无定稿不回退", async () => {
  const f = fixture();
  try {
    const target = f.add("版本文章", undefined, "# 版本文章\n未定稿的新编辑");
    finalize(target, "早期定稿", "2026-01-01");
    const expected = finalize(target, "最后成功定稿", "2026-02-01");
    finalize(target, "失败定稿", "2026-03-01", "failed");
    finalize(target, "其他专题定稿", "2026-04-01");
    target.finalizations.at(-1)!.topicId = "other";
    f.db.write(target);
    const access = f.access();
    await access.tools[0].invoke({ query: "版本文章" });
    assert.equal((await access.tools[1].invoke({ id: target.id })).content, target.results.article);
    const final = await access.tools[1].invoke({ id: target.id, version: "finalized" });
    assert.equal(final.content, "最后成功定稿"); assert.equal(final.versionId, expected);
    const draft = f.add("只有草稿");
    const missing = f.access(); await missing.tools[0].invoke({ query: "只有草稿" });
    await assert.rejects(missing.tools[1].invoke({ id: draft.id, version: "finalized" }), /没有成功的定稿/);
    assert.throws(() => missing.assertComplete(), /没有成功的定稿/);
  } finally { f.close(); }
});

test("已删除、空正文、缺失成稿版本和未经搜索读取均阻止交付", async () => {
  const f = fixture();
  try {
    const deleted = f.add("将删除");
    const access = f.access(); await access.tools[0].invoke({ query: "将删除" });
    f.db.remove(deleted.id, () => {});
    await assert.rejects(access.tools[1].invoke({ id: deleted.id }), /已删除/);
    assert.throws(() => access.assertComplete(), /已删除/);
    const empty = f.add("空正文", undefined, "");
    const emptyAccess = f.access(); await emptyAccess.tools[0].invoke({ query: empty.id });
    await assert.rejects(emptyAccess.tools[1].invoke({ id: empty.id }), /正文为空/);
    const broken = f.add("损坏版本");
    finalize(broken, "旧稿", "2026-01-01");
    broken.articleVersions = [];
    f.db.write(broken);
    const brokenAccess = f.access(); await brokenAccess.tools[0].invoke({ query: broken.id });
    await assert.rejects(brokenAccess.tools[1].invoke({ id: broken.id, version: "finalized" }), /版本不存在/);
    const unsearched = f.access();
    await assert.rejects(unsearched.tools[1].invoke({ id: empty.id }), /先搜索/);
    assert.throws(() => unsearched.assertComplete(), /先搜索/);
  } finally { f.close(); }
});

test("重试失败状态不能通过后续工具调用清除，新请求不继承参考授权", async () => {
  const f = fixture();
  try {
    const target = f.add("正常文章");
    const access = f.access();
    await access.tools[0].invoke({ query: target.id });
    await access.tools[1].invoke({ id: target.id });
    assert.equal((await access.tools[0].invoke({ query: "不存在" })).status, "not_found");
    await assert.rejects(access.tools[0].invoke({ query: "不存在", retryOf: "不存在" }), /未找到/);
    await assert.rejects(access.tools[1].invoke({ id: target.id }), /未找到/);
    assert.throws(() => access.assertComplete(), /未找到/);
    await assert.rejects(f.access().tools[1].invoke({ id: target.id }), /先搜索/);
  } finally { f.close(); }
});

test("实际成果更新入口拦截失败或未读完的参考，保留各阶段成果、确认及版本", async () => {
  const f = fixture();
  try {
    const target = f.add("参考目标");
    for (const stage of ["analysis", "topics", "outline", "article"] as const) {
      for (const failed of [false, true]) {
        const project = f.current;
        project.stage = stage; project.results[stage] = "原有成果";
        project.directionConfirmed = true; project.outlineConfirmed = true;
        const before = structuredClone(project);
        const access = f.access();
        if (failed) assert.equal((await access.tools[0].invoke({ query: "不存在" })).status, "not_found");
        else await access.tools[0].invoke({ query: target.id });
        assert.throws(() => applyAgentResult(project, "参考文章改写", "找不到文章，请选择", "stage", access.assertComplete));
        assert.deepEqual(project, before);
        if (stage === "topics") {
          assert.throws(() => applyAgentResult(project, "参考文章调整方向", "询问文字", "direction", access.assertComplete));
          assert.deepEqual(project, before);
        }
      }
    }
    const access = f.access();
    await access.tools[0].invoke({ query: target.id });
    await access.tools[1].invoke({ id: target.id });
    applyAgentResult(f.current, "参考文章改写", "新正文", "stage", access.assertComplete);
    assert.equal(f.current.results.article, "新正文");
    assert.equal(f.current.messages.at(-1)?.content, "新正文");
    assert.equal(f.current.outlineConfirmed, true);
  } finally { f.close(); }
});

test("乡村厨房完整标题忽略 AI 两侧空格、全角空格及大小写", async () => {
  const f = fixture();
  try {
    const target = f.add("怎么用 AI 画出一间很舒服的乡村厨房插画");
    for (const query of ["怎么用AI画出一间很舒服的乡村厨房插画", "怎么用　ai　画出一间很舒服的乡村厨房插画"]) {
      const access = f.access();
      assert.equal((await access.tools[0].invoke({ query })).selectedId, target.id);
      assert.equal((await access.tools[1].invoke({ id: target.id })).content, target.results.article);
      access.assertComplete();
    }
  } finally { f.close(); }
});

test("上一篇按最近更新时间选择，跳过当前项目、其他专题和空白文章", async () => {
  const f = fixture();
  try {
    const old = f.add("更早文章"); old.updatedAt = "2026-09-20T01:00:00Z"; f.db.write(old);
    const target = f.add("乡村厨房"); target.updatedAt = "2026-09-22T03:09:30Z"; f.db.write(target);
    const blank = f.add("空白文章", undefined, " "); blank.updatedAt = "2026-09-22T03:20:00Z"; f.db.write(blank);
    const otherTopic = f.current.topicId === "jianxi" ? "tech123" : "jianxi";
    const other = f.add("其他专题", otherTopic); other.updatedAt = "2026-09-22T03:30:00Z"; f.db.write(other);
    f.current.results.article = "# 当前文章"; f.current.updatedAt = "2026-09-22T04:00:00Z"; f.db.write(f.current);
    for (const query of ["上一篇", "参考上一篇", "上一篇文章"]) {
      const access = f.access();
      assert.equal((await access.tools[0].invoke({ query })).selectedId, target.id);
      await access.tools[1].invoke({ id: target.id }); access.assertComplete();
    }
    assert.equal((await f.access().tools[0].invoke({ query: "上一篇", scope: "all" })).selectedId, other.id);
    assert.equal((await f.access().tools[0].invoke({ query: "上一篇", scope: otherTopic })).selectedId, other.id);
  } finally { f.close(); }
});

test("没有其他正文时上一篇明确失败，不选择空白项目", async () => {
  const f = fixture();
  try {
    f.add("空白", undefined, "");
    const access = f.access();
    await assert.rejects(access.tools[0].invoke({ query: "上一篇" }), /未找到/);
    assert.throws(() => access.assertComplete(), /未找到/);
  } finally { f.close(); }
});

test("最近文章只返回当前专题按更新时间排序的 N 篇有正文文章，且必须逐篇读取", async () => {
  const f = fixture();
  try {
    const old = f.add("较早正文"); old.updatedAt = "2026-09-20T01:00:00Z"; f.db.write(old);
    const middle = f.add("中间正文"); middle.updatedAt = "2026-09-21T01:00:00Z"; f.db.write(middle);
    const latest = f.add("最新正文"); latest.updatedAt = "2026-09-22T01:00:00Z"; f.db.write(latest);
    const blank = f.add("最新空白", undefined, " "); blank.updatedAt = "2026-09-23T01:00:00Z"; f.db.write(blank);
    const otherTopic = f.current.topicId === "jianxi" ? "tech123" : "jianxi";
    const other = f.add("其他专题最新", otherTopic); other.updatedAt = "2026-09-24T01:00:00Z"; f.db.write(other);
    const access = f.access();
    const result = await access.tools[0].invoke({ query: "最近文章", limit: 2 });
    assert.deepEqual(result.selectedIds, [latest.id, middle.id]);
    assert.equal(result.selectedId, null);
    assert.equal(result.hasMore, true);
    assert.throws(() => access.assertComplete(), /尚未读取/);
    await access.tools[1].invoke({ id: latest.id });
    assert.throws(() => access.assertComplete(), /尚未读取/);
    await access.tools[1].invoke({ id: middle.id });
    access.assertComplete();
    await assert.rejects(f.access().tools[0].invoke({ query: "最近文章", scope: "all" }), /当前专题/);
  } finally { f.close(); }
});

test("无匹配可缩短原关键词重试，全部参考读完才可交付", async () => {
  const f = fixture();
  try {
    const target = f.add("乡村厨房插画");
    const access = f.access();
    const query = "你参考一下这篇文章：怎么用AI画出乡村厨房插画";
    const first = await access.tools[0].invoke({ query });
    assert.equal(first.status, "not_found");
    assert.throws(() => access.assertComplete(), /未找到/);
    const retry = await access.tools[0].invoke({ query: "乡村厨房", retryOf: query });
    assert.equal(retry.selectedId, target.id);
    assert.throws(() => access.assertComplete(), /尚未读取/);
    await access.tools[1].invoke({ id: target.id });
    access.assertComplete();
  } finally { f.close(); }
});

test("其他文章查阅成功不能掩盖未解决查询，也不能换范围或无关关键词重试", async () => {
  const f = fixture();
  try {
    const target = f.add("乡村厨房插画");
    const access = f.access();
    await access.tools[0].invoke({ query: "不存在的文章" });
    await access.tools[0].invoke({ query: target.id });
    await access.tools[1].invoke({ id: target.id });
    assert.throws(() => access.assertComplete(), /未找到/);
    await assert.rejects(access.tools[0].invoke({ query: "乡村厨房", retryOf: "不存在的文章" }), /不能替换/);
    const cross = f.access();
    await cross.tools[0].invoke({ query: "乡村厨房的另一个标题" });
    await assert.rejects(cross.tools[0].invoke({ query: "乡村厨房", scope: "all", retryOf: "乡村厨房的另一个标题" }), /专题范围/);
  } finally { f.close(); }
});
