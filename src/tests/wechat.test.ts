import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { load } from "cheerio";
import { formatArticle } from "../lib/wechat/format";
import { WechatStore } from "../lib/wechat/store";
import { enqueueHistory, persistResponse, processAccount } from "../lib/wechat/sync";
import { articleStatistics } from "../lib/wechat/statistics";
import { beijingToday, bucketRanges, datesBetween, shiftDate, statisticsRange } from "../lib/wechat/dates";
import { draftSchema, DraftConflict, pushDraft } from "../lib/wechat/draft";
import { WechatError } from "../lib/wechat/client";
import type { PublishConfig } from "../lib/wechat/config";
import { parsePublishSettings } from "../lib/wechat/config";
import { newProject } from "../lib/project";

// 所有回归用例使用内存 SQLite 和假微信接口，绝不读取真实凭证或文章库。
function fixture() {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY)");
  return new WechatStore(db);
}

test("公众号设置按专题 ID 从本地配置名读取并校验", () => {
  assert.deepEqual(parsePublishSettings("my-topic", {
    WECHAT_MY_TOPIC_APP_ID: "example-id", WECHAT_MY_TOPIC_APP_SECRET: "example-secret",
    WECHAT_MY_TOPIC_AUTHOR: "示例作者", WECHAT_MY_TOPIC_NEED_OPEN_COMMENT: "false",
  }), { AppID: "example-id", AppSecret: "example-secret", author: "示例作者",
    defaultThumbMediaId: undefined, needOpenComment: false, onlyFansCanComment: false });
  assert.equal(parsePublishSettings("new-topic", {}), null);
  assert.throws(() => parsePublishSettings("my-topic", {
    WECHAT_MY_TOPIC_APP_ID: "id", WECHAT_MY_TOPIC_APP_SECRET: "secret",
    WECHAT_MY_TOPIC_NEED_OPEN_COMMENT: "enabled",
  }), /仅支持 true 或 false/);
});
function pending(store: WechatStore, source: string, date: string) {
  store.db.prepare("INSERT OR IGNORE INTO wx_fetches(account,source,date,state) VALUES('account',?,?,'pending')").run(source, date);
}

test("三种排版不改正文，只提取首个一级标题，代码缩进和图片语法保留", () => {
  const markdown = '# 标题\n\n原文**重点**。\n\n## 已有小标题\n\n3. 第三项\n4. 第四项\n\n> 引用\n\n```js\n  const x = "<a>";\n```\n\n（配图要求：保留原文，不生成图片）\n\n![说明](https://example.com/a.png)';
  for (const theme of ["ink", "green", "blue"] as const) {
    const result = formatArticle(markdown, "候选标题", theme), $ = load(result.html);
    assert.equal(result.title, "标题"); assert.equal($("h1").length, 0); assert.equal($("h2").text(), "已有小标题");
    assert.equal($("pre code").text(), '  const x = "<a>";'); assert.equal($("ol").attr("start"), "3");
    assert.ok($("body > section").attr("style")?.includes("font-weight:300"));
    assert.equal($("pre").prev("section").find("span").length, 3);
    assert.ok($("pre").parent().attr("style")?.includes("box-shadow"));
    assert.equal($("img").length, 0); assert.ok($.text().includes('![说明](https://example.com/a.png)'));
    const note = $("span").filter((_, element) => $(element).text().startsWith("（配图要求"));
    assert.equal(note.length, 1); assert.ok(note.attr("style")?.includes("color:")); assert.ok(!note.attr("style")?.includes("border"));
    assert.equal($("h2").length, 1); assert.ok(!result.html.includes("font-family"));
  }
});
test("普通段落不猜小标题，危险 HTML 与链接不能执行，代码里的配图要求不染色", () => {
  const { html, title } = formatArticle('普通第一段\n\n<script>alert(1)</script>\n\n[链接](javascript:alert)\n\n```\n(配图要求:原样代码)\n```', "备用标题");
  const $ = load(html); assert.equal(title, "备用标题"); assert.equal($("h1,h2,h3,script,a").length, 0);
  assert.equal($("pre span").length, 0); assert.equal($("pre").text(), "(配图要求:原样代码)");
});
test("代码块使用显式换行，避免公众号富文本折叠源码换行", () => {
  const { html } = formatArticle("```ts\nconst first = 1;\n\n  const second = 2;\n```", "标题");
  const $ = load(html), code = $("pre code");
  assert.equal(code.find("br").length, 3);
  assert.equal(code.html(), "const first = 1;<br><br>  const second = 2;");
});
test("多行文本使用明确像素行高，避免公众号将比例行高误判为重叠风险", () => {
  const { html } = formatArticle("正文\n\n## 小标题\n\n- 列表项\n\n```ts\nconst value = 1;\n```", "标题");
  const $ = load(html);
  assert.ok($("section").first().attr("style")?.includes("line-height:30px"));
  assert.ok($("p, li").toArray().every(element => $(element).attr("style")?.includes("line-height:30px")));
  assert.ok($("h2").attr("style")?.includes("line-height:32px"));
  assert.ok($("pre").attr("style")?.includes("line-height:24px"));
  assert.ok(!html.includes("line-height:1.85") && !html.includes("line-height:1.7"));
});
test("清雅绿为代码块输出可见的绿色外框", () => {
  const { html } = formatArticle("```ts\nconst value = 1;\n```", "标题", "green");
  const $ = load(html), frame = $("pre").parent();
  assert.ok(frame.attr("style")?.includes("border:2px solid #78a995"));
  assert.ok(frame.children().first().attr("style")?.includes("border-bottom:1px solid #78a995"));
});
test("GFM 表格输出公众号可识别的表头、正文和对齐样式", () => {
  const markdown = "| 名称 | 数值 | 备注 |\n| :--- | ---: | :---: |\n| A & B | 12 | **重点**\n| C |  | [链接](https://example.com) |";
  const { html } = formatArticle(markdown, "标题", "green");
  const $ = load(html), table = $("table");
  assert.equal(table.length, 1);
  assert.equal(table.find("thead tr th").length, 3);
  assert.equal(table.find("tbody tr").length, 2);
  assert.equal(table.find("tbody td").eq(0).text(), "A & B");
  assert.equal(table.find("tbody td").eq(1).text(), "12");
  assert.equal(table.find("tbody td").eq(2).find("a").attr("href"), "https://example.com");
  assert.ok(table.find("thead th").eq(0).attr("style")?.includes("text-align:left"));
  assert.ok(table.find("thead th").eq(1).attr("style")?.includes("text-align:right"));
  assert.ok(table.parent().attr("style")?.includes("overflow-x:auto"));
});
test("北京时间及90天比较跨月跨年，月周汇总保留不完整首尾", () => {
  assert.equal(beijingToday(new Date("2026-01-01T17:00:00Z")), "2026-01-02");
  const range = statisticsRange("2025-12-01", "2026-02-28");
  assert.equal(range.days, 90); assert.equal(range.previousEnd, "2025-11-30");
  assert.equal(datesBetween(range.previousStart, range.previousEnd).length, 90);
  assert.deepEqual(bucketRanges("2026-01-30", "2026-02-02", "month"), [
    { start: "2026-01-30", end: "2026-01-31", partial: true }, { start: "2026-02-01", end: "2026-02-02", partial: true }]);
  assert.equal(bucketRanges("2026-01-06", "2026-01-15", "week")[0].end, "2026-01-11");
});
test("全部历史倒序处理，重复启动不重建已完成项，租约互斥且可恢复", () => {
  const store = fixture();
  try {
    enqueueHistory(store, "account", false, new Date("2026-05-10T02:00:00Z"));
    const first = store.db.prepare("SELECT MIN(date) AS first,MAX(date) AS last FROM wx_fetches").get();
    assert.deepEqual(first, { first: "2025-11-01", last: "2026-05-09" });
    store.db.prepare("UPDATE wx_fetches SET state='complete' WHERE date='2026-05-09'").run();
    enqueueHistory(store, "account", false, new Date("2026-05-10T02:01:00Z"));
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM wx_fetches WHERE date='2026-05-09' AND state='complete'").get() as { n: number }).n, 4);
    assert.equal(store.lease("sync:account", "a"), true); assert.equal(store.lease("sync:account", "b"), false);
    store.release("sync:account", "a"); assert.equal(store.lease("sync:account", "b"), true);
    enqueueHistory(store, "account", true, new Date("2026-05-10T02:02:00Z"));
    assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM wx_fetches WHERE date='2026-05-09' AND state='pending'").get() as { n: number }).n, 4);
  } finally { store.db.close(); }
});
test("统计接口无权限只停用该接口，继续获取其余数据并向页面返回提示", async () => {
  const store = fixture();
  try {
    for (const source of ["getbizsummary", "getarticleread"] as const) pending(store, source, "2026-05-09");
    const config = { AppID: "account", AppSecret: "fake", needOpenComment: true, onlyFansCanComment: false };
    await processAccount(config, store, async <T = Record<string, unknown>>(_config: PublishConfig, path: string, _payload: unknown): Promise<T> => {
      if (path.endsWith("getarticleread")) throw new WechatError("公众号没有此接口权限，请检查账号认证与权限。", 48001);
      return { is_delay: false, list: [{ ref_date: "2026-05-09", detail: { read_user: 8 } }] } as T;
    });
    assert.equal((store.db.prepare("SELECT state FROM wx_fetches WHERE source='getbizsummary'").get() as { state: string }).state, "complete");
    assert.equal((store.db.prepare("SELECT state FROM wx_fetches WHERE source='getarticleread'").get() as { state: string }).state, "unavailable");
    const result = articleStatistics("account", "2026-05-09", "2026-05-09", undefined, store);
    assert.deepEqual(result.sync.unavailableSources.map(item => item.source), ["getarticleread"]);
    assert.equal(result.sync.unavailableSources[0]?.label, "图文阅读");
  } finally { store.db.close(); }
});
test("重复采集覆盖日数据，延迟不作比较，累计快照不进入日趋势", () => {
  const store = fixture();
  try {
    for (const date of ["2026-01-01", "2026-01-02"]) {
      pending(store, "getbizsummary", date);
      persistResponse(store, "account", "getbizsummary", date, { is_delay: false, list: [{ ref_date: date, detail: { read_user: 10, share_user: 1 } }] });
    }
    persistResponse(store, "account", "getbizsummary", "2026-01-02", { is_delay: false, list: [{ detail: { read_user: 20, share_user: 2 } }] });
    let result = articleStatistics("account", "2026-01-02", "2026-01-02", undefined, store);
    assert.equal(result.summary[0].value, 20); assert.equal(result.summary[0].change, 100);
    pending(store, "getarticletotaldetail", "2026-01-01");
    persistResponse(store, "account", "getarticletotaldetail", "2026-01-01", { is_delay: false, list: [{ msgid: "10_1", title: "文章", ref_date: "2026-01-01",
      detail_list: [{ stat_date: "2026-01-01", read_user: 100 }, { stat_date: "2026-01-02", read_user: 120 }] }] });
    result = articleStatistics("account", "2026-01-02", "2026-01-02", "10_1", store);
    assert.equal(result.total?.values.read_user, 120); assert.equal(result.summary[0].value, null);
    persistResponse(store, "account", "getbizsummary", "2026-01-02", { is_delay: "true", list: [{ detail: { read_user: 22 } }] });
    result = articleStatistics("account", "2026-01-02", "2026-01-02", undefined, store);
    assert.equal(result.summary[0].change, null); assert.equal(result.chart[0].values.read_user, null);
  } finally { store.db.close(); }
});
test("成功的单篇空列表表示无活动，未获取与缺失字段不填零", () => {
  const store = fixture();
  try {
    pending(store, "getarticleread", "2026-01-01");
    persistResponse(store, "account", "getarticleread", "2026-01-01", { is_delay: false, list: [] });
    const result = articleStatistics("account", "2026-01-01", "2026-01-02", "10_1", store);
    assert.equal(result.chart[0].values.read_user, 0); assert.equal(result.chart[1].values.read_user, null);
    assert.equal(result.summary[0].complete, false);
  } finally { store.db.close(); }
});
test("365天区间保留实际起点，历史不足时禁止伪造完整比较", () => {
  const store = fixture();
  try {
    const end = "2026-05-01", start = shiftDate(end, -364);
    const result = articleStatistics("account", start, end, undefined, store);
    assert.equal(result.range.days, 365); assert.equal(result.range.start, start);
    assert.equal(result.summary[0].change, null); assert.equal(result.range.granularity, "month");
  } finally { store.db.close(); }
});

test("草稿新增防重、更新确认及保留远端封面，未保存正文不能推送", async () => {
  const store = fixture(), project = newProject("jianxi"); project.topicId = "tech123"; project.results.article = "# 标题\n\n当前正文";
  store.db.prepare("INSERT INTO projects VALUES(?)").run(project.id);
  const rendered = formatArticle(project.results.article, "标题"), calls: { path: string; body: unknown }[] = [];
  let remote = { title: "标题", content: "后台手工配图正文", thumb_media_id: "manual-cover", author: "作者", need_open_comment: 1 };
  const dependencies = { publishConfig: async () => ({ AppID: "account", AppSecret: "not-a-secret", defaultThumbMediaId: "default-cover",
    author: "Tech123", needOpenComment: true, onlyFansCanComment: false }),
    wechatStore: () => store, readProject: async () => project,
    wechatCall: async <T>(_config: unknown, path: string, body: unknown): Promise<T> => {
      calls.push({ path, body });
      if (path.endsWith("/add")) return { media_id: "draft-1" } as T;
      if (path.endsWith("/get")) return { news_item: [remote] } as T;
      if (path.endsWith("/update")) { remote = { ...remote, ...(body as { articles: typeof remote }).articles }; return {} as T; }
      throw new Error("未知假接口");
    } };
  const input = draftSchema.parse({ projectId: project.id, topicId: "tech123", markdown: project.results.article,
    fallbackTitle: "标题", theme: "ink", fingerprint: rendered.fingerprint, requestId: crypto.randomUUID() });
  try {
    await pushDraft(input, dependencies); await pushDraft(input, dependencies);
    assert.equal(calls.filter(item => item.path.endsWith("/add")).length, 1);
    const added = calls.find(item => item.path.endsWith("/add"))!.body as { articles: Record<string, unknown>[] };
    assert.equal(added.articles[0].author, "Tech123"); assert.equal(added.articles[0].need_open_comment, 1);
    assert.equal(added.articles[0].only_fans_can_comment, 0);
    await assert.rejects(pushDraft({ ...input, requestId: crypto.randomUUID() }, dependencies), (error: unknown) => error instanceof DraftConflict && error.reason === "overwrite");
    await pushDraft({ ...input, requestId: crypto.randomUUID(), confirmOverwrite: true }, dependencies);
    const update = calls.find(item => item.path.endsWith("/update"))!.body as { articles: Record<string, unknown> };
    assert.equal(update.articles.thumb_media_id, "manual-cover"); assert.equal(update.articles.author, "作者"); assert.equal(update.articles.need_open_comment, 1);
    assert.equal(update.articles.content, rendered.html);
    await assert.rejects(pushDraft({ ...input, markdown: "尚未保存" }, dependencies), /正文或专题已变化/);
    store.db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    assert.equal((store.db.prepare("SELECT project_id FROM wx_drafts").get() as { project_id: unknown }).project_id, null);
  } finally { store.db.close(); }
});
test("新增请求结果不确定时先核对，不自动重发", async () => {
  const store = fixture(), project = newProject("jianxi"); project.topicId = "tech123"; project.results.article = "正文";
  store.db.prepare("INSERT INTO projects VALUES(?)").run(project.id);
  let adds = 0;
  const dependencies = { publishConfig: async () => ({ AppID: "account", AppSecret: "fake", defaultThumbMediaId: "cover", needOpenComment: true, onlyFansCanComment: false }),
    wechatStore: () => store, readProject: async () => project,
    wechatCall: async <T>(_config: unknown, path: string): Promise<T> => {
      if (path.endsWith("/add")) { adds++; throw new WechatError("模拟超时", null, true); }
      if (path.endsWith("/batchget")) return { item: [], total_count: 0 } as T;
      throw new Error("未知接口");
    } };
  const input = draftSchema.parse({ projectId: project.id, topicId: "tech123", markdown: "正文", fallbackTitle: "标题", title: "标题",
    fingerprint: formatArticle("正文", "标题").fingerprint, requestId: crypto.randomUUID() });
  try {
    await assert.rejects(pushDraft(input, dependencies), /模拟超时/);
    await assert.rejects(pushDraft(input, dependencies), (error: unknown) => error instanceof DraftConflict && error.reason === "uncertain");
    assert.equal(adds, 1);
  } finally { store.db.close(); }
});

test("已删除草稿需要明确重建，默认封面缺失不能新增", async () => {
  const store = fixture(), project = newProject("jianxi"); project.topicId = "tech123"; project.results.article = "正文";
  store.db.prepare("INSERT INTO projects VALUES(?)").run(project.id);
  const rendered = formatArticle("正文", "标题");
  store.saveDraft("account", project.id, project.topicId, "deleted-draft", "old", "ink");
  let adds = 0;
  const config: { AppID: string; AppSecret: string; defaultThumbMediaId?: string; needOpenComment: boolean; onlyFansCanComment: boolean } = { AppID: "account", AppSecret: "fake", defaultThumbMediaId: "cover", needOpenComment: true, onlyFansCanComment: false };
  const dependencies = { publishConfig: async () => config, wechatStore: () => store, readProject: async () => project,
    wechatCall: async <T>(_config: unknown, path: string): Promise<T> => {
      if (path.endsWith("/get")) throw new WechatError("草稿不存在", 40007);
      if (path.endsWith("/add")) { adds++; return { media_id: "new-draft" } as T; }
      throw new Error("未知接口");
    } };
  const input = draftSchema.parse({ projectId: project.id, topicId: "tech123", markdown: "正文", title: "标题", fallbackTitle: "标题",
    fingerprint: rendered.fingerprint, requestId: crypto.randomUUID() });
  try {
    await assert.rejects(pushDraft(input, dependencies), (error: unknown) => error instanceof DraftConflict && error.reason === "missing");
    assert.equal(adds, 0);
    await pushDraft({ ...input, recreate: true }, dependencies); assert.equal(adds, 1);
    delete config.defaultThumbMediaId;
    await assert.rejects(pushDraft({ ...input, requestId: crypto.randomUUID(), recreate: true }, dependencies), /永久封面素材/);
    assert.equal(adds, 1);
  } finally { store.db.close(); }
});

test("配图说明跨越加粗节点仍着色，删除本地项目不删公众号统计", () => {
  const formatted = formatArticle("正文\n\n（配图要求：**图中文字**保持原样）", "标题");
  const $ = load(formatted.html);
  assert.ok($("strong span").attr("style")?.includes("color:"));
  const store = fixture();
  try {
    const id = crypto.randomUUID(); store.db.prepare("INSERT INTO projects VALUES(?)").run(id);
    store.saveDraft("account", id, "tech123", "draft", "fingerprint", "ink");
    pending(store, "getbizsummary", "2026-01-01");
    persistResponse(store, "account", "getbizsummary", "2026-01-01", { list: [{ detail: { read_user: 9 } }], is_delay: false });
    store.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    assert.equal(articleStatistics("account", "2026-01-01", "2026-01-01", undefined, store).summary[0].value, 9);
  } finally { store.db.close(); }
});
