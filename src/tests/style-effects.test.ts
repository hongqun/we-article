import assert from "node:assert/strict";
import test from "node:test";
import { newProject, type ArticleVersion, type Finalization } from "../lib/project";
import { makeEvent, collectEdits } from "../lib/style-memory/events";
import { editingSessions, finalArticleEffect, textChangePercent, versionUsage } from "../lib/style-memory/effects";

// 统计按实际请求与成稿版本关联，失败调用和单纯点击都不能制造学习效果。
test("沿用已有模型候选不产生手写风格证据", () => {
  const before = newProject("jianxi"); before.results.topics = "1. 别急着证明自己\n2. 留一点空间";
  const after = { ...before, selectedTopic: "别急着证明自己" };
  assert.equal(collectEdits(before, after)[0].kind, "context");
});

test("手工编辑不按时长拆分，后续写作动作才分隔时段", () => {
  const project = newProject("jianxi");
  const events = [0, 60, 120, 600].map(seconds => makeEvent(project, { kind: "manual", stage: "article", target: "article",
    before: "旧稿", after: "新稿", createdAt: new Date(seconds * 1000).toISOString() }));
  assert.deepEqual(editingSessions(events), { manualSessions: 1, feedbackCount: 0, editCount: 1 });
  events.push(makeEvent(project, { kind: "feedback", stage: "article", target: "article", before: "", after: "", instruction: "改结尾",
    createdAt: new Date(90 * 1000).toISOString() }));
  assert.deepEqual(editingSessions(events), { manualSessions: 2, feedbackCount: 1, editCount: 3 });
});

test("文字变化忽略空白，不把缺少原稿当成零修改", () => {
  assert.equal(textChangePercent("甲乙 丙丁", "甲乙\n丙丁"), 0);
  assert.equal(textChangePercent("甲乙", "丙丁"), 100);
  assert.equal(textChangePercent("", "成稿"), null);
});

test("只取生成该版本的记忆；删除来源或缺失记录时标为未知", () => {
  const project = newProject("jianxi");
  const requestId = crypto.randomUUID();
  const initial: ArticleVersion = { id: crypto.randomUUID(), content: "模型正文", source: "generation", summary: "初稿",
    createdAt: "2026-09-21T00:00:00.000Z", requestId, topicId: "jianxi" };
  const final: ArticleVersion = { ...initial, id: crypto.randomUUID(), source: "manual", requestId: undefined, content: "修改正文" };
  project.articleVersions = [initial, final];
  const record: Finalization = { id: crypto.randomUUID(), articleVersionId: final.id, topicId: "jianxi",
    createdAt: "2026-09-21T01:00:00.000Z", status: "completed", originalOutline: "大纲", revisedOutline: null,
    structuralChange: false, reason: "", feedbackCount: 0, manualEdited: true, styleUsed: true };
  const usage = makeEvent(project, { kind: "usage", stage: "article", target: "article", before: "", after: "", relatedId: requestId,
    usage: { versionId: 1, trendIds: ["倾向一"], exampleIds: [], context: "偏好" } });
  const failed = { ...usage, id: crypto.randomUUID(), relatedId: crypto.randomUUID(),
    usage: { versionId: 99, trendIds: [], exampleIds: [], context: "" } };
  assert.equal(versionUsage(initial, [failed, usage])?.versionId, 1);
  assert.equal(finalArticleEffect(project, record, [failed, usage]).styleUsed, true);
  assert.equal(finalArticleEffect(project, record, [failed]).styleUsed, null);
  usage.usage!.redacted = true;
  assert.equal(finalArticleEffect(project, record, [usage]).styleUsed, null);
});
