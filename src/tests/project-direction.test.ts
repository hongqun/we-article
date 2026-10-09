import assert from "node:assert/strict";
import test from "node:test";
import { agentRunName } from "../lib/agent";
import { newProject, projectSchema, invalidateDirection, hasCurrentDirection, hasConfirmedDirection, canWriteArticle, hasProjectContent, outlineBasis, stageForViewing, toProjectSummary } from "../lib/project";
import { listWritingTopics, loadWritingPrompt, readWritingTopic } from "../lib/topics";

// 无模型、无文件写入：覆盖方向确认及上游失效的纯状态规则。
function confirmedProject() {
  const project = newProject("jianxi");
  return { ...project, topicId: "jianxi", selectedTopic: "给自己的心力设限",
    coreDirection: "讨论过度承担的代价，帮助读者区分责任与额外负担。",
    directionTopic: "给自己的心力设限", directionConfirmed: true,
    outlineConfirmed: true, results: { ...project.results, analysis: "材料解读", outline: "三段思路", article: "已有正文" } };
}

test("旧见隙项目保留成果，但未确认方向不能进入正文生成", () => {
  const legacy: Record<string, unknown> = { ...confirmedProject() };
  delete legacy.coreDirection;
  delete legacy.directionTopic;
  delete legacy.directionConfirmed;
  const project = projectSchema.parse(legacy);
  assert.equal(project.coreDirection, "");
  assert.equal(project.directionConfirmed, false);
  assert.equal(project.results.article, "已有正文");
  assert.equal(canWriteArticle(project), false);
});

test("见隙正文要求当前标题、方向和大纲均已确认", () => {
  const project = confirmedProject();
  assert.equal(hasCurrentDirection(project), true);
  assert.equal(canWriteArticle(project), true);
  assert.equal(hasConfirmedDirection({ ...project, directionConfirmed: false }), false);
  assert.equal(hasConfirmedDirection({ ...project, directionTopic: "另一个标题" }), false);
  assert.equal(hasConfirmedDirection({ ...project, coreDirection: "  " }), false);
});

test("标题、材料、链接、解读及专题变化要求重新整理方向", () => {
  const previous = confirmedProject();
  const edits = [
    { selectedTopic: "新的标题" }, { source: "新材料" }, { url: "https://example.com" },
    { results: { ...previous.results, analysis: "新的解读" } }, { topicId: "tech123" },
  ];
  for (const patch of edits) {
    const next = invalidateDirection({ ...previous, ...patch }, previous);
    assert.equal(next.directionConfirmed, false);
    assert.equal(next.outlineConfirmed, false);
    assert.equal(next.directionTopic, "");
    assert.equal(next.coreDirection, previous.coreDirection);
    assert.equal(next.results.article, previous.results.article);
  }
});

test("手动修改方向保留标题绑定但撤销确认", () => {
  const previous = confirmedProject();
  const next = invalidateDirection({ ...previous, coreDirection: "修改后的方向" }, previous);
  assert.equal(hasCurrentDirection(next), true);
  assert.equal(next.directionConfirmed, false);
  assert.equal(next.outlineConfirmed, false);
});

test("编辑正文、查看阶段和保存重开不撤销方向确认", () => {
  const previous = confirmedProject();
  const next = invalidateDirection({ ...previous, stage: "article",
    results: { ...previous.results, article: "手动修改的正文" } }, previous);
  const reopened = projectSchema.parse(JSON.parse(JSON.stringify(next)));
  assert.equal(hasConfirmedDirection(reopened), true);
  assert.equal(canWriteArticle(reopened), true);
});

test("专题从配置发现，未知专题不能使用", async () => {
  assert.equal(newProject("jianxi").topicId, "jianxi");
  assert.deepEqual((await listWritingTopics()).map(topic => topic.id).sort(), ["jianxi", "tech123"]);
  await assert.rejects(loadWritingPrompt("general", "article"));
});

test("空项目不算有内容，材料或阶段成果项目才算有内容", () => {
  const empty = newProject("jianxi");
  assert.equal(hasProjectContent(empty), false);
  assert.equal(hasProjectContent({ ...empty }), false);
  assert.equal(hasProjectContent({ ...empty, source: "材料" }), true);
  assert.equal(hasProjectContent({ ...empty, results: { ...empty.results, outline: "大纲" } }), true);
  assert.equal(hasProjectContent({ ...empty, messages: [{ role: "user", content: "继续", stage: "analysis" }] }), true);
});

test("打开时当前阶段为空会回退到最近的有内容阶段", () => {
  const project = { ...newProject("jianxi"), stage: "article" as const,
    results: { analysis: "解读", topics: "选题", outline: "大纲", article: "" } };
  assert.equal(stageForViewing(project), "outline");
  assert.equal(stageForViewing({ ...project, results: { ...project.results, article: "正文" } }), "article");
});

// 两套专题共用确认闸门，正文编辑仍不会触发重做上游。
test("见隙须确认方向与大纲后才可写正文", () => {
  const project = { ...confirmedProject(), directionConfirmed: false, outlineConfirmed: false };
  assert.equal(canWriteArticle(project), false);
  assert.equal(canWriteArticle({ ...project, selectedTopic: " " }), false);
  assert.equal(canWriteArticle({ ...project, topicId: "tech123" }), false);
  assert.equal(canWriteArticle({ ...project, results: { ...project.results, analysis: "" } }), false);
});

test("Tech123 复用题目确认流程，专题切换待复核时不能直接写正文", () => {
  const project = { ...confirmedProject(), topicId: "tech123", outlineConfirmed: false,
    directionConfirmed: false, topicReviewPending: true };
  assert.equal(canWriteArticle(project), false);
  assert.equal(canWriteArticle({ ...project, topicReviewPending: false }), false);
  assert.equal(canWriteArticle({ ...project, topicReviewPending: false, outlineConfirmed: true,
    directionConfirmed: true }), true);
  assert.equal(hasConfirmedDirection(project), false);
  const changed = invalidateDirection({ ...project, selectedTopic: "新的技术题目" }, project);
  assert.equal(changed.directionTopic, "");
});

test("正文首行标题更新文章列表，但不改动选题方向", () => {
  const project = { ...confirmedProject(), results: { ...confirmedProject().results,
    article: "# 正文中新定的标题\n\n正文内容" } };
  assert.match(toProjectSummary(project).title, /正文中新定的标题$/);
  assert.equal(toProjectSummary(project).topicId, "jianxi");
  assert.equal(project.selectedTopic, "给自己的心力设限");
  assert.equal(toProjectSummary({ ...project, results: { ...project.results, article: "正文没有一级标题" } }).title.endsWith(project.selectedTopic), true);
});

test("写作 Agent 名称按正文标题、选题标题和阶段回退", () => {
  const base = { ...newProject("jianxi"), topicId: "tech123", selectedTopic: "已确认的选题" };
  assert.equal(agentRunName({ ...base, stage: "article", results: { ...base.results, article: "# 正文标题\n\n正文" } }, "写作思路"), "《正文标题》 · 文章正文");
  assert.equal(agentRunName({ ...base, stage: "topics" }, "写作思路"), "《已确认的选题》 · 文章选题");
  assert.equal(agentRunName({ ...base, stage: "analysis", selectedTopic: " " }, "写作思路"), "材料解读");
  assert.equal(agentRunName({ ...base, stage: "outline" }, "写作思路"), "《已确认的选题》 · 写作思路");
});

test("Tech123 正文读取独立规则和范文，并启用同一本地写作技能", async () => {
  const prompt = await loadWritingPrompt("tech123", "article");
  const topic = await readWritingTopic("tech123");
  assert.equal(topic.writingSkill, "human-writing");
  assert.equal(topic.styleMemory, true);
  assert.match(prompt.prompt, /章节和篇幅由材料决定/);
  assert.match(prompt.prompt, /视觉创作/);
  assert.doesNotMatch(prompt.prompt, /正文每段目标字数/);
});

test("正文修改保留大纲依据，题目与方向变化使其失效", () => {
  const project = confirmedProject();
  const basis = outlineBasis(project);
  assert.equal(outlineBasis({ ...project, results: { ...project.results, article: "用户改写" } }), basis);
  assert.notEqual(outlineBasis({ ...project, selectedTopic: "新题目" }), basis);
  assert.notEqual(outlineBasis({ ...project, coreDirection: "新方向" }), basis);
});
