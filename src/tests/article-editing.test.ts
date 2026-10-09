import assert from "node:assert/strict";
import test from "node:test";
import { newProject, type ArticleVersion } from "../lib/project";
import { buildAgentContext, buildCurrentInstruction } from "../lib/agent-context";
import { mergeAutosavedProject, shouldAppendManualVersion } from "../lib/article-autosave";

// 模拟用户删改后继续提意见，旧助手正文及旧思考不能重新进入改写消息。
test("正文改写以最新编辑稿为底稿，移除历史助手正文", () => {
  for (const topicId of ["jianxi", "tech123"]) {
    const project = { ...newProject("jianxi"), topicId, stage: "article" as const };
    project.results.article = "这是手工修改后保留的正文。";
    project.messages = [
      { role: "user", content: "写得具体一些", stage: "article", topicId, operation: "stage" },
      { role: "assistant", content: "已经被用户删除的旧句子。", reasoningContent: "旧思考", stage: "article", topicId, operation: "stage" },
    ];
    const context = buildAgentContext(project, "stage");
    const instruction = buildCurrentInstruction(project, "只修改最后一句");
    assert.deepEqual(context.messages, []);
    assert.match(JSON.stringify(context.data), /写得具体一些/);
    assert.doesNotMatch(JSON.stringify(context), /已经被用户删除|旧思考/);
    assert.match(instruction, /这是手工修改后保留的正文/);
    assert.match(instruction, /只修改最后一句/);
    assert.doesNotMatch(instruction, /已经被用户删除/);
  }
});

// 当前用例：改纲后重建正文只传新大纲，旧正文保存在项目版本而不进入模型输入。
test("按新大纲重写不把旧正文带进模型上下文", () => {
  const project = { ...newProject("jianxi"), stage: "article" as const, selectedTopic: "我不跟你吵，不是我怕你",
    results: { ...newProject("jianxi").results,
      outline: "第一段：不吵是一种强大，是深刻的自我认同。第二段：争执成本。第三段：边界行动。",
      article: "# 我不跟你吵，不是我怕你\n\n旧正文第一段：被挑衅后想顶回去。" } };
  const context = buildAgentContext(project, "stage", true);
  const instruction = buildCurrentInstruction(project, "请生成完整的文章正文。", true);
  assert.match(JSON.stringify(context.data), /不吵是一种强大/);
  assert.doesNotMatch(JSON.stringify(context.data), /被挑衅后想顶回去/);
  assert.match(instruction, /我不跟你吵，不是我怕你/);
  assert.doesNotMatch(instruction, /被挑衅后想顶回去/);
});

// 候选重新生成从当前材料重新探索，不把旧选题对话续接给模型。
test("重新生成候选时移除选题历史对话", () => {
  const project = { ...newProject("jianxi"), topicId: "tech123", stage: "topics" as const,
    results: { ...newProject("jianxi").results, analysis: "当前材料解读" },
    messages: [
      { role: "user" as const, content: "旧的选题要求", stage: "topics" as const, topicId: "tech123", operation: "stage" as const },
      { role: "assistant" as const, content: "旧的候选标题", stage: "topics" as const, topicId: "tech123", operation: "stage" as const },
    ] };
  const context = buildAgentContext(project, "stage", false, true);
  assert.deepEqual(context.messages, []);
  assert.match(JSON.stringify(context.data), /当前材料解读/);
  assert.doesNotMatch(JSON.stringify(context), /旧的选题要求|旧的候选标题/);
});

// 第三步重新生成从当前材料和已确认方向重新整理，不续接旧大纲对话。
test("重新生成大纲时移除大纲历史对话", () => {
  const project = { ...newProject("jianxi"), topicId: "tech123", stage: "outline" as const,
    selectedTopic: "一个已确认的标题", coreDirection: "一个已确认的核心方向",
    results: { ...newProject("jianxi").results, analysis: "当前材料解读", outline: "旧的大纲" },
    messages: [
      { role: "user" as const, content: "旧的大纲修改要求", stage: "outline" as const, topicId: "tech123", operation: "stage" as const },
      { role: "assistant" as const, content: "旧的大纲回答", stage: "outline" as const, topicId: "tech123", operation: "stage" as const },
    ] };
  const context = buildAgentContext(project, "stage", false, false, true);
  assert.deepEqual(context.messages, []);
  assert.match(JSON.stringify(context.data), /当前材料解读/);
  assert.doesNotMatch(JSON.stringify(context), /旧的大纲修改要求|旧的大纲回答/);
});

test("自动保存旧响应只补元数据，保留保存期间的新编辑", () => {
  const base = newProject("jianxi");
  const saved = { ...base, updatedAt: "2026-09-19T12:00:00Z", results: { ...base.results, article: "请求时的正文" } };
  const current = { ...base, selectedTopic: "刚修改的标题", results: { ...base.results, article: "继续输入的新正文" } };
  const merged = mergeAutosavedProject(current, saved, false);
  assert.equal(merged.results.article, current.results.article);
  assert.equal(merged.selectedTopic, current.selectedTopic);
  assert.equal(merged.updatedAt, saved.updatedAt);
  assert.equal(mergeAutosavedProject({ ...current, id: crypto.randomUUID() }, saved, false).results.article, current.results.article);
  assert.equal(mergeAutosavedProject(current, saved, true).results.article, saved.results.article);
});

// 合并自动快照频率不改写历史；显式保存和生成前保存始终留存最新正文。
test("连续自动保存控制快照频率，显式保存不受限制", () => {
  const latest: ArticleVersion = { id: crypto.randomUUID(), createdAt: "2026-09-19T12:00:00Z",
    content: "上一个快照", source: "manual", summary: "自动保存正文快照", autosaved: true };
  const time = Date.parse(latest.createdAt);
  assert.equal(shouldAppendManualVersion(latest, "继续编辑", true, time + 1500), false);
  assert.equal(shouldAppendManualVersion(latest, "继续编辑", true, time + 30000), true);
  assert.equal(shouldAppendManualVersion(latest, "继续编辑", false, time + 1500), true);
  assert.equal(shouldAppendManualVersion(latest, latest.content, false, time + 30000), false);
  assert.equal(shouldAppendManualVersion({ ...latest, source: "rewrite", autosaved: undefined }, "用户改写", true, time + 1500), true);
  assert.equal(shouldAppendManualVersion(latest, "", false, time + 1500), true);
  assert.equal(latest.content, "上一个快照");
});
