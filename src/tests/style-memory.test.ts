import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StyleMemoryStore, type SummaryBatch } from "../lib/style-memory/store";
import { collectEdits, groupStyleEditSessions, makeEvent } from "../lib/style-memory/events";
import { selectFromTrends } from "../lib/style-memory/service";
import { transferOutbox } from "../lib/style-memory/outbox";
import { newProject, projectSchema } from "../lib/project";
import type { MemoryEvent, SummaryResult } from "../lib/style-memory/types";

// 全部使用内存 SQLite 和固定模型结果，不调用真实模型，不触碰用户项目。
function event(projectId = crypto.randomUUID(), kind: MemoryEvent["kind"] = "manual"): MemoryEvent {
  return { id: crypto.randomUUID(), projectId, topicId: "jianxi", createdAt: new Date().toISOString(),
    kind, target: "article", stage: "article", operation: "stage", before: "我们必须努力改变未来。", after: "明天先拒绝一件额外的工作。",
    instruction: kind === "feedback" ? "以后结尾都给一个具体的小行动。" : "", title: "职场边界", direction: "从额外工作说起" };
}
function claim(store: StyleMemoryStore, mode: "auto" | "manual" = "manual", now?: Date): SummaryBatch {
  const batch = store.claim(mode, now);
  assert.notEqual(typeof batch, "string");
  return batch as SummaryBatch;
}
function proposal(events: MemoryEvent[], existingId: string | null = null, oppose = false): SummaryResult {
  return { changes: [{ existingId, text: "结尾给一个具体的小行动", scene: "结尾", stage: "article", operation: "stage",
    evidence: events.map(e => ({ eventId: e.id, relation: oppose ? "oppose" : "support", quote: e.kind === "feedback" ? e.instruction : e.after, explicit: e.kind === "feedback" })) }] };
}
function withStore(run: (store: StyleMemoryStore) => void) {
  const store = new StyleMemoryStore(":memory:", "jianxi");
  try { run(store); } finally { store.close(); }
}

test("旧项目默认空转存列表，保存和阶段推进不会生成认可事件", () => {
  const old = { ...newProject("jianxi"), topicId: "jianxi" };
  const legacy: Record<string, unknown> = { ...old }; delete legacy.memoryOutbox;
  assert.deepEqual(projectSchema.parse(legacy).memoryOutbox, []);
  assert.deepEqual(collectEdits(old, { ...old, stage: "topics", outlineConfirmed: true }), []);
});

test("各阶段手动修改有明确归属，模型目标和材料变化不作为手动风格", () => {
  const old = { ...newProject("jianxi"), topicId: "jianxi" };
  const next = { ...old, source: "新材料", selectedTopic: "标题", coreDirection: "方向",
    results: { analysis: "解读", topics: "候选", outline: "大纲", article: "正文" } };
  const edits = collectEdits(old, next, "article");
  assert.equal(edits.filter(e => e.kind === "manual").length, 5);
  assert.equal(edits.find(e => e.target === "coreDirection")?.operation, "direction");
  assert.equal(edits.find(e => e.target === "source")?.kind, "context");
  assert.equal(edits.some(e => e.target === "article"), false);
  assert.deepEqual(collectEdits(next, next), []);
  assert.deepEqual(collectEdits(old, { ...next, topicId: "tech123" }), []);
});

test("事件转存幂等，模型、按钮、恢复和材料不进入总结", () => withStore(store => {
  const user = event();
  const all = [user, ...(["model", "button", "restore", "context", "usage"] as const).map(kind => event(undefined, kind))];
  store.ingest(all); store.ingest(all);
  assert.equal(store.view().pendingCount, 1);
  assert.equal(store.events(all.map(e => e.id)).length, 6);
  const batch = claim(store);
  assert.deepEqual(batch.events.map(e => e.id), [user.id]);
}));

test("两个专题共用数据库但证据、画像与每日整理额度相互隔离", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "article-style-scope-"));
  const filename = path.join(directory, "style.sqlite");
  const jianxi = new StyleMemoryStore(filename, "jianxi");
  const tech123 = new StyleMemoryStore(filename, "tech123");
  try {
    const first = event();
    const second = { ...event(), topicId: "tech123" as const };
    jianxi.ingest([first]); tech123.ingest([second]);
    assert.throws(() => tech123.ingest([first]), /作用域/);
    assert.equal(jianxi.events([second.id]).length, 0);
    assert.equal(tech123.events([first.id]).length, 0);
    const now = new Date("2026-09-19T02:00:00Z");
    jianxi.complete(claim(jianxi, "auto", now), proposal([first]));
    assert.equal(tech123.view().trends.length, 0);
    assert.equal(tech123.view().pendingCount, 1);
    assert.notEqual(typeof tech123.claim("auto", now), "string");
    assert.throws(() => tech123.manage(jianxi.trends()[0].id, "disable"), /不存在/);
  } finally {
    jianxi.close(); tech123.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("同篇多次修改不足以启用，三篇独立支持后启用", () => withStore(store => {
  const projectId = crypto.randomUUID();
  const same = [event(projectId), event(projectId), event(projectId)];
  store.ingest(same); store.complete(claim(store), proposal(same));
  assert.equal(store.trends()[0].status, "observing");
  const others = [event(), event()]; store.ingest(others);
  store.complete(claim(store), proposal(others, store.trends()[0].id));
  assert.equal(store.trends()[0].status, "active");
}));

test("连续正文保存聚合为一个文章级编辑会话，但保留全部证据 ID", () => {
  const projectId = crypto.randomUUID();
  const first = { ...event(projectId), createdAt: "2026-09-25T00:00:00.000Z", before: "旧稿", after: "第一版" };
  const second = { ...event(projectId), createdAt: "2026-09-25T00:01:00.000Z", before: "第一版", after: "最终版" };
  const other = { ...event(), createdAt: "2026-09-25T00:02:00.000Z" };
  const sessions = groupStyleEditSessions([first, second, other]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].eventIds, [first.id, second.id]);
  assert.equal(sessions[0].before, "旧稿");
  assert.equal(sessions[0].after, "最终版");
  assert.deepEqual(sessions[0].eventSources.map(source => source.eventId), [first.id, second.id]);
  assert.equal(sessions[0].eventSources[0].after, "第一版");
  assert.equal(sessions[0].eventSources[1].after, "最终版");
});

test("明确长期原话可启用，手动修改的 explicit 标志不能越过门槛", () => withStore(store => {
  const manual = event(); store.ingest([manual]);
  const result = proposal([manual]); result.changes[0].evidence[0].explicit = true;
  store.complete(claim(store), result);
  assert.equal(store.trends()[0].status, "observing");
  const feedback = event(undefined, "feedback"); store.ingest([feedback]);
  store.complete(claim(store), proposal([feedback], store.trends()[0].id));
  assert.equal(store.trends()[0].status, "active");
}));

test("相反修改使倾向暂停，用户纠正解除冲突并保留原文证据", () => withStore(store => {
  const initial = event(undefined, "feedback"); store.ingest([initial]); store.complete(claim(store), proposal([initial]));
  const opposite = { ...event(), after: "留给读者自己决定。" }; store.ingest([opposite]);
  const id = store.trends()[0].id;
  store.complete(claim(store), proposal([opposite], id, true));
  assert.equal(store.trends()[0].status, "conflicted");
  store.manage(id, "correct", "涉及建议时给小行动，情绪表达时可以留白。");
  const trend = store.trends()[0];
  assert.equal(trend.status, "active"); assert.equal(trend.userEdited, true);
  assert.ok(trend.evidence.some(e => e.relation === "oppose" && e.resolved));
  assert.ok(trend.evidence.some(e => e.relation === "revision"));
  assert.equal(store.view().versions.length, 3);
}));

test("停用不会被模型更新复活，用户修订停用项仍须手动恢复", () => withStore(store => {
  const initial = event(undefined, "feedback"); store.ingest([initial]); store.complete(claim(store), proposal([initial]));
  const id = store.trends()[0].id; store.manage(id, "disable");
  const more = event(); store.ingest([more]); store.complete(claim(store), proposal([more], id));
  assert.equal(store.trends()[0].status, "disabled");
  store.manage(id, "correct", "结尾给小行动，但不要求每篇都给。");
  assert.equal(store.trends()[0].status, "disabled");
  store.manage(id, "restore"); assert.equal(store.trends()[0].status, "active");
}));

test("失败不推进游标，同日自动不重复，手动可重试", () => withStore(store => {
  store.ingest([event()]);
  const now = new Date("2026-09-19T02:00:00Z");
  const batch = claim(store, "auto", now);
  store.fail(batch.runId, "模拟失败");
  assert.equal(store.view().pendingCount, 1);
  assert.equal(typeof store.claim("auto", now), "string");
  assert.notEqual(typeof store.claim("manual", now), "string");
}));

test("按北京时间跨日；手动成功也占用当天自动额度", () => withStore(store => {
  const first = event(); store.ingest([first]);
  const now = new Date("2026-09-19T15:59:00Z");
  store.complete(claim(store, "manual", now), { changes: [] });
  store.ingest([event()]);
  assert.equal(typeof store.claim("auto", now), "string");
  assert.notEqual(typeof store.claim("auto", new Date("2026-09-19T16:01:00Z")), "string");
}));

test("并发占用防止重复，过期运行不能提交覆盖新运行", () => withStore(store => {
  store.ingest([event()]);
  const old = claim(store, "manual", new Date("2026-09-19T00:00:00Z"));
  assert.equal(typeof store.claim("manual", new Date("2026-09-19T00:01:00Z")), "string");
  claim(store, "manual", new Date("2026-09-19T00:06:00Z"));
  assert.throws(() => store.complete(old, { changes: [] }), /过期/);
  assert.equal(store.view().pendingCount, 1);
}));

test("批次上界固定，总结期间新增记录留到下一批", () => withStore(store => {
  store.ingest([event()]); const batch = claim(store);
  const next = event(); store.ingest([next]);
  store.complete(batch, { changes: [] });
  assert.equal(store.view().pendingCount, 1);
  assert.equal(claim(store).events[0].id, next.id);
}));

test("超长修改分段处理，未读部分不被游标跳过", () => withStore(store => {
  const long = { ...event(), before: "旧".repeat(21000), after: "新".repeat(21000) }; store.ingest([long]);
  for (const length of [10000, 10000, 1000]) {
    const batch = claim(store); assert.equal(batch.events[0].after.length, length);
    store.complete(batch, { changes: [] });
  }
  assert.equal(store.view().pendingCount, 0);
  assert.equal(store.events([long.id])[0].after.length, 21000);
}));

test("模型编造证据时事务回滚，画像和处理进度不变", () => withStore(store => {
  const input = event(); store.ingest([input]); const batch = claim(store);
  const bad = proposal([input]); bad.changes[0].evidence[0].quote = "并不存在的引用";
  assert.throws(() => store.complete(batch, bad), /原文/);
  assert.equal(store.trends().length, 0); assert.equal(store.view().versions.length, 0);
  assert.equal(store.view().pendingCount, 1);
}));

test("合并会话中 eventId 贴错时按真实原文事件归属证据", () => withStore(store => {
  const first = event();
  const second = { ...event(first.projectId), after: "另一版修改" };
  store.ingest([first, second]);
  const batch = claim(store);
  const result = proposal([second]);
  result.changes[0].evidence[0].quote = first.after;
  store.complete(batch, result);
  assert.equal(store.trends()[0].evidence[0].eventId, first.id);
}));

test("总结期间用户修改画像，旧结果不能覆盖用户选择", () => withStore(store => {
  const first = event(); store.ingest([first]); store.complete(claim(store), proposal([first]));
  store.ingest([event()]); const batch = claim(store);
  store.manage(store.trends()[0].id, "disable");
  assert.throws(() => store.complete(batch, { changes: [] }), /画像已被修改/);
  assert.equal(store.trends()[0].status, "disabled");
}));

test("上下文只使用匹配阶段的有效倾向，并限制条数及字符预算", () => withStore(store => {
  const inputs = Array.from({ length: 12 }, () => event(undefined, "feedback")); store.ingest(inputs);
  const result = { changes: inputs.map((e, i) => ({ ...proposal([e]).changes[0], text: `结尾偏好${i}` })) };
  store.complete(claim(store), result);
  const project = { ...newProject("jianxi"), topicId: "jianxi", stage: "article" as const, selectedTopic: "结尾" };
  const usage = selectFromTrends(store.trends(), inputs, project, "stage", "结尾", store.latestVersion());
  assert.equal(usage.trendIds.length, 5); assert.ok(usage.context.length <= 4000);
  assert.equal(usage.exampleIds.length, 0); // 用户反馈不是手动修改前后对照。
  const other = selectFromTrends(store.trends(), inputs, { ...project, stage: "analysis" }, "stage", "", null);
  assert.equal(other.context, "");
  assert.equal(makeEvent(project, { kind: "usage", target: "article", before: "", after: "", usage }).usage?.trendIds.length, 5);
}));

test("专题可配置只注入适用文章场景或通用倾向", async () => {
  const { readWritingTopic } = await import("../lib/topics");
  const config = await readWritingTopic("tech123");
  const project = { ...newProject("jianxi"), topicId: "tech123", stage: "article" as const,
    selectedTopic: "视觉教程怎么写", results: { ...newProject("jianxi").results, analysis: "按步骤说明视觉教程。" } };
  const trend = (id: string, scene: string) => ({ id, scene, text: "把做法讲清楚", stage: "article" as const,
    operation: "stage" as const, status: "active" as const, userEdited: false, updatedAt: "2026-09-19", evidence: [] });
  const usage = selectFromTrends([trend("visual", "视觉教程/步骤"), trend("interview", "面试解答/步骤"),
    trend("shared", "通用/表达")], [], project, "stage", "请写正文", null,
    config.styleMemoryCategories, config.styleMemoryDefaultCategory, config.styleMemoryGenericLabel);
  assert.deepEqual(usage.trendIds, ["visual", "shared"]);
});


test("数据库失败保留待办；清理失败后的重复转存不会重复学习", async () => {
  const store = new StyleMemoryStore(":memory:", "jianxi");
  try {
    const input = event();
    const project = { ...newProject("jianxi"), topicId: "jianxi", memoryOutbox: [input] };
    let writes = 0;
    const unavailable = await transferOutbox(project, {
      ingest: () => { throw new Error("数据库不可用"); }, persist: async () => { writes++; },
    });
    assert.equal(unavailable.memoryOutbox.length, 1); assert.equal(writes, 0);
    const afterCrash = await transferOutbox(project, {
      ingest: events => store.ingest(events), persist: async () => { throw new Error("模拟写回失败"); },
    });
    assert.equal(afterCrash.memoryOutbox.length, 1); assert.equal(store.view().pendingCount, 1);
    const recovered = await transferOutbox(afterCrash, {
      ingest: events => store.ingest(events), persist: async clean => { writes++; assert.deepEqual(clean.memoryOutbox, []); },
    });
    assert.deepEqual(recovered.memoryOutbox, []); assert.equal(writes, 1);
    assert.equal(store.view().pendingCount, 1);
  } finally { store.close(); }
});

// 跨阶段参考改变适用位置，不改写原始证据，也不降低长期倾向启用门槛。
test("正文修改可支持选题、方向与大纲，证据仍归属正文", () => withStore(store => {
  const input = event(); store.ingest([input]);
  const changes: SummaryResult["changes"] = [
    { ...proposal([input]).changes[0], stage: "topics", text: "选题聚焦具体行动" },
    { ...proposal([input]).changes[0], stage: "topics", operation: "direction", text: "方向落到具体行动" },
    { ...proposal([input]).changes[0], stage: "outline", text: "思路落到具体行动" },
  ];
  store.complete(claim(store), { changes });
  assert.equal(store.trends().length, 3);
  assert.ok(store.trends().every(trend => trend.status === "observing"));
  assert.equal(store.events([input.id])[0].stage, "article");
  assert.equal(store.view().pendingCount, 0);
}));

test("不能把其他阶段证据任意转给正文", () => withStore(store => {
  const input = { ...event(), stage: "analysis" as const }; store.ingest([input]);
  assert.throws(() => store.complete(claim(store), proposal([input])), /不匹配/);
  assert.equal(store.trends().length, 0);
}));

test("本篇单次修改即时参考上游，模型输出和其他文章不混入", () => withStore(store => {
  const project = { ...newProject("jianxi"), topicId: "jianxi", stage: "outline" as const };
  const input = event(project.id);
  store.ingest([input, event(project.id, "model"), event(project.id, "button"), event()]);
  const recent = store.recentBodyEdits(project.id);
  assert.deepEqual(recent.map(e => e.id), [input.id]);
  const usage = selectFromTrends([], recent, project, "stage", "", null);
  assert.deepEqual(usage.trendIds, []);
  assert.deepEqual(usage.exampleIds, [input.id]);
  assert.match(usage.context, /尚不代表长期偏好/);
  assert.equal(selectFromTrends([], recent, { ...project, id: crypto.randomUUID() }, "stage", "", null).context, "");
  store.complete(claim(store), proposal([input]));
  store.manage(store.trends()[0].id, "disable");
  assert.equal(selectFromTrends(store.trends(), recent, project, "stage", "", null).context, "");
}));
