import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publishConfig } from "./config";
import { formatArticle } from "./format";
import { wechatCall, WechatError } from "./client";
import { wechatStore } from "./store";
import { readProject } from "../storage";

export const previewSchema = z.object({ projectId: z.string().uuid(), topicId: z.string(), markdown: z.string().max(100000),
  fallbackTitle: z.string().max(200), theme: z.enum(["ink", "green", "blue"]).default("ink"), title: z.string().max(200).optional() });
export const draftSchema = previewSchema.extend({ requestId: z.string().uuid(), fingerprint: z.string(),
  confirmOverwrite: z.boolean().default(false), recreate: z.boolean().default(false),
  recoveryMediaId: z.string().trim().min(1).max(256).optional(), confirmAbsent: z.boolean().default(false) });
export class DraftConflict extends Error { constructor(message: string, readonly reason: string) { super(message); } }
type RemoteArticle = Record<string, unknown> & { title: string; content: string };
export async function pushDraft(input: z.infer<typeof draftSchema>, dependencies = { publishConfig, wechatStore, readProject, wechatCall }) {
  // 依赖参数让回归用例使用临时数据库和假接口，不触碰真实账号。
  const { publishConfig: readConfig, wechatStore: getStore, readProject: getProject, wechatCall: call } = dependencies;
  const config = await readConfig(input.topicId);
  if (!config) throw new Error("此专题未配置公众号。");
  const store = getStore(), owner = randomUUID(), lock = `draft:${config.AppID}:${input.projectId}`;
  if (!store.lease(lock, owner, 180_000)) throw new Error("此文章正在推送，请稍后重试。");
  try {
    const project = await getProject(input.projectId);
    if (project.topicId !== input.topicId || project.results.article !== input.markdown) throw new Error("正文或专题已变化，请保存并刷新预览。");
    const rendered = formatArticle(input.markdown, project.selectedTopic, input.theme, input.title);
    if (rendered.fingerprint !== input.fingerprint) throw new Error("排版结果已变化，请刷新预览。");
    if (Array.from(rendered.title).length > 32) throw new Error("公众号标题最多 32 个字符，请在预览中手动调整。");
    if (rendered.html.length >= 20000 || Buffer.byteLength(rendered.html, "utf8") >= 1024 * 1024) throw new Error("排版后正文超出微信长度限制，请手动调整；未截断正文。");
    const previousAttempt = store.attempt(input.requestId);
    if (previousAttempt && (previousAttempt.account !== config.AppID || previousAttempt.project_id !== project.id ||
      JSON.parse(previousAttempt.payload).fingerprint !== rendered.fingerprint)) throw new Error("推送请求标识已用于其他内容。");
    if (previousAttempt?.state === "succeeded") return { mediaId: previousAttempt.media_id, message: "该请求已成功推送。" };

    // 重启或请求超时后，先核对尚未确认的新增操作，绝不盲目重发。
    const unknown = store.db.prepare("SELECT * FROM wx_attempts WHERE account=? AND project_id=? AND state IN ('pending','unknown') ORDER BY created_at DESC LIMIT 1")
      .get(config.AppID, project.id) as { id: string; payload: string } | undefined;
    if (unknown && input.confirmAbsent) {
      // 用户在后台核对无草稿后才能解除不确定状态；不会自动认定未创建。
      store.db.prepare("UPDATE wx_attempts SET state='failed',error=? WHERE id=?").run("用户核对后台后确认未创建。", unknown.id);
    } else if (unknown && input.recoveryMediaId) {
      const remote = await call<{ news_item: RemoteArticle[] }>(config, "/cgi-bin/draft/get", { media_id: input.recoveryMediaId });
      if (remote.news_item?.length !== 1) throw new Error("手动绑定仅支持单篇草稿，请选择只有一篇文章的草稿。");
      const pending = JSON.parse(unknown.payload) as { topicId: string; theme: string };
      store.db.transaction(() => {
        store.saveDraft(config.AppID, project.id, pending.topicId, input.recoveryMediaId!, "", pending.theme);
        store.db.prepare("UPDATE wx_attempts SET state='reconciled',media_id=?,error=NULL WHERE id=?").run(input.recoveryMediaId, unknown.id);
      })();
    } else if (unknown) {
      const pending = JSON.parse(unknown.payload) as { html: string; title: string; mediaId?: string; topicId: string; fingerprint: string; theme: string };
      if (!pending.mediaId) {
        let offset = 0, found: string | undefined;
        do {
          store.lease(lock, owner, 180_000);
          const page = await call<{ item?: { media_id: string; content?: { news_item?: RemoteArticle[] } }[]; total_count: number }>(config,
            "/cgi-bin/draft/batchget", { offset, count: 20, no_content: 0 });
          const matches = (page.item ?? []).filter(item => item.content?.news_item?.[0]?.title === pending.title && item.content.news_item[0].content === pending.html);
          if (matches.length > 1 || (found && matches.length)) throw new DraftConflict("找到多个可能的草稿，请在公众号后台核对，暂不重复创建。", "uncertain");
          if (matches[0]) found = matches[0].media_id;
          offset += (page.item ?? []).length;
          if (!page.item?.length || offset >= page.total_count) break;
        } while (offset < 1000);
        if (!found) throw new DraftConflict("上次新增结果未确认，未找到内容完全一致的草稿。请核对公众号后台；系统不会自动重复创建。", "uncertain");
        store.db.transaction(() => {
          store.saveDraft(config.AppID, project.id, pending.topicId, found!, pending.fingerprint, pending.theme);
          store.db.prepare("UPDATE wx_attempts SET state='succeeded',media_id=?,error=NULL WHERE id=?").run(found, unknown.id);
        })();
        if (pending.fingerprint === rendered.fingerprint) return { mediaId: found, message: "已核对到上次创建的草稿。" };
      } else {
        // 更新是同一远端 ID 的覆盖写；读取确认后才允许再次覆盖。
        const remote = await call<{ news_item: RemoteArticle[] }>(config, "/cgi-bin/draft/get", { media_id: pending.mediaId });
        const item = remote.news_item?.[0];
        if (item?.title === pending.title && item.content === pending.html) {
          store.saveDraft(config.AppID, project.id, pending.topicId, pending.mediaId, pending.fingerprint, pending.theme);
          store.db.prepare("UPDATE wx_attempts SET state='succeeded',error=NULL WHERE id=?").run(unknown.id);
          if (pending.fingerprint === rendered.fingerprint) return { mediaId: pending.mediaId, message: "已核对上次更新成功。" };
        } else store.db.prepare("UPDATE wx_attempts SET state='failed',error=? WHERE id=?").run("已读取远端，内容不一致，允许确认后重新更新。", unknown.id);
      }
    }
    const draft = store.draft(config.AppID, project.id, input.topicId);
    let mediaId = draft?.media_id ?? undefined;
    const articleIndex = draft?.article_index ?? 0;
    // 首次建稿使用专题发布默认值；更新已有草稿时继续以远端设置为准。
    let article: Record<string, unknown> = { article_type: "news", title: rendered.title, content: rendered.html,
      thumb_media_id: config.defaultThumbMediaId, author: config.author,
      need_open_comment: Number(config.needOpenComment), only_fans_can_comment: Number(config.onlyFansCanComment) };
    if (mediaId) {
      let remote: { news_item: RemoteArticle[] } | undefined;
      try { remote = await call(config, "/cgi-bin/draft/get", { media_id: mediaId }); }
      catch (error) {
        if (!(error instanceof WechatError) || ![40007, 46001].includes(error.code ?? 0)) throw error;
        if (!input.recreate) throw new DraftConflict("原草稿已不存在，是否使用当前内容重新创建？", "missing");
        mediaId = undefined;
      }
      if (remote) {
        const existing = remote.news_item?.[articleIndex];
        if (!existing) throw new Error("远端草稿缺少文章，请到公众号后台核对。");
        if (existing.title === rendered.title && existing.content === rendered.html) return { mediaId, message: "公众号草稿已是当前排版内容。" };
        if (!input.confirmOverwrite) throw new DraftConflict("将替换公众号草稿正文，包括后台添加的配图和文字；已有封面及设置将保留。", "overwrite");
        article = {};
        for (const key of ["article_type", "author", "digest", "content_source_url", "thumb_media_id", "need_open_comment", "only_fans_can_comment", "cover_info", "product_info"])
          if (existing[key] !== undefined) article[key] = existing[key];
        article.title = rendered.title; article.content = rendered.html;
      }
    }
    if (!mediaId && !config.defaultThumbMediaId) throw new Error("请先在专题 publish.defaultThumbMediaId 配置已有永久封面素材 ID。");
    const payload = JSON.stringify({ ...rendered, topicId: input.topicId, mediaId, articleIndex, versionId: project.articleVersions.at(-1)?.id });
    store.db.prepare(`INSERT INTO wx_attempts VALUES(?,?,?,'pending',?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET state='pending',payload=excluded.payload,error=NULL`)
      .run(input.requestId, config.AppID, project.id, payload, mediaId ?? null, new Date().toISOString());
    try {
      if (mediaId) await call(config, "/cgi-bin/draft/update", { media_id: mediaId, index: articleIndex, articles: article });
      else {
        const result = await call<{ media_id?: string }>(config, "/cgi-bin/draft/add", { articles: [article] });
        if (!result.media_id) throw new WechatError("微信未返回草稿 ID，请核对远端草稿。", null, true);
        mediaId = result.media_id;
      }
      store.db.transaction(() => {
        store.saveDraft(config.AppID, project.id, input.topicId, mediaId!, rendered.fingerprint, input.theme, articleIndex);
        store.db.prepare("UPDATE wx_attempts SET state='succeeded',media_id=?,error=NULL WHERE id=?").run(mediaId, input.requestId);
      })();
      return { mediaId, message: "已推送到公众号草稿箱，请到公众号后台补图并发布。" };
    } catch (error) {
      store.db.prepare("UPDATE wx_attempts SET state=?,error=? WHERE id=?").run(
        error instanceof WechatError && !error.uncertain ? "failed" : "unknown", error instanceof Error ? error.message : "推送失败", input.requestId);
      throw error;
    }
  } finally { store.release(lock, owner); }
}
