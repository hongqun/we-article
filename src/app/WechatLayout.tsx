"use client";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../lib/project";
import { createUuid } from "../lib/uuid";

type Theme = "ink" | "green" | "blue";
type Preview = { title: string; html: string; theme: Theme; fingerprint: string; markdownHash: string; hasDraft: boolean; coverConfigured: boolean };
type PushResult = { state: "pending" | "success" | "error"; title: string; detail: string; mediaId?: string };
const themes: Record<Theme, string> = { ink: "素雅黑", green: "清雅绿", blue: "简洁蓝" };
// 弹窗持有可见快照；只有保存成功且正文未变化，才能推送用户看到的版本。
export default function WechatLayout({ project, onClose, saveBeforePush }: {
  project: Project; onClose: () => void; saveBeforePush: (markdown: string, topicId: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<Theme>("ink"), [title, setTitle] = useState<string | undefined>();
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  // 推送结果单独保留，避免被预览或复制提示覆盖，用户可在按钮附近确认本次结果。
  const [pushResult, setPushResult] = useState<PushResult | null>(null);
  const [requestId, setRequestId] = useState(() => createUuid());
  const [snapshot, setSnapshot] = useState(project.results.article);
  const generation = useRef(0);
  const [uncertain, setUncertain] = useState(false), [recoveryMediaId, setRecoveryMediaId] = useState("");
  const changed = snapshot !== project.results.article;
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let active = true;
    void fetch(`/api/wechat/preview?projectId=${project.id}`).then(response => response.json()).then(data => {
      if (active && data.theme in themes) setTheme(data.theme);
    }).catch(() => {});
    return () => { active = false; };
  }, [project.id]);
  useEffect(() => {
    const controller = new AbortController(), serial = ++generation.current;
    setPreview(null); setError("");
    const timeout = setTimeout(() => {
      void fetch("/api/wechat/preview", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ projectId: project.id, topicId: project.topicId, markdown: snapshot,
          fallbackTitle: project.selectedTopic, theme, title }) }).then(async response => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error);
          if (generation.current === serial) { setPreview(data); setRequestId(createUuid()); }
        }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    }, 200);
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [project.id, project.topicId, project.selectedTopic, snapshot, theme, title]);
  async function push(recovery?: { recoveryMediaId?: string; confirmAbsent?: boolean }) {
    if (!preview || changed) return;
    const updating = preview.hasDraft;
    setBusy(true); setError(""); setMessage("");
    setPushResult({ state: "pending", title: updating ? "正在更新公众号草稿" : "正在推送公众号草稿", detail: "请勿关闭此窗口或重复点击。" });
    try {
      await saveBeforePush(snapshot, project.topicId);
      const payload = { projectId: project.id, topicId: project.topicId, markdown: snapshot, fallbackTitle: project.selectedTopic,
        theme, title: preview.title, fingerprint: preview.fingerprint, requestId, confirmOverwrite: false, recreate: false, ...recovery };
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch("/api/wechat/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (response.status === 409 && ["overwrite", "missing"].includes(result.reason)) {
          if (!window.confirm(result.error)) return;
          if (result.reason === "overwrite") payload.confirmOverwrite = true;
          else payload.recreate = true;
          continue;
        }
        if (result.reason === "uncertain") setUncertain(true);
        if (!response.ok) throw new Error(result.error);
        setPushResult({ state: "success", title: updating ? "公众号草稿已更新" : "已推送到公众号草稿箱",
          detail: result.message, mediaId: result.mediaId });
        setUncertain(false); setRequestId(createUuid()); setPreview(current => current ? { ...current, hasDraft: true } : null);
        return;
      }
      throw new Error("远端草稿状态变化，请重新打开预览后重试。");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "推送失败";
      setError(detail);
      setPushResult({ state: "error", title: "公众号草稿推送失败", detail });
    }
    finally { setBusy(false); }
  }
  async function copy() {
    if (!preview) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([preview.html], { type: "text/html" }),
        "text/plain": new Blob([new DOMParser().parseFromString(preview.html, "text/html").body.textContent ?? ""], { type: "text/plain" }) })]);
      setMessage("已复制排版正文，公众号标题请单独填写。");
    } catch { setError("复制失败，请检查浏览器剪贴板权限。"); }
  }
  return <dialog ref={dialog} className="wx-layout-dialog" aria-labelledby="wx-layout-title" onCancel={event => { if (busy) event.preventDefault(); }} onClose={onClose}>
    <header><div><h2 id="wx-layout-title">公众号排版</h2><p>只排版，不改写。标题单独展示，配图请到公众号后台补充。</p></div>
      <button disabled={busy} onClick={() => dialog.current?.close()}>关闭</button></header>
    <div className="wx-layout-controls"><label>排版样式 <select value={theme} disabled={busy} onChange={event => setTheme(event.target.value as Theme)}>
      {Object.entries(themes).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>公众号标题 <input value={title ?? preview?.title ?? ""} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="输入公众号标题" /></label></div>
    {changed && <p role="alert">正文已变化。<button disabled={busy} onClick={() => { setSnapshot(project.results.article); setTitle(undefined); }}>刷新预览</button></p>}
    {preview ? <div className="wx-phone-preview"><h1>{preview.title}</h1>
      <iframe title="公众号正文预览" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="margin:0;padding:16px;">${preview.html}</body></html>`} /></div>
      : !error ? <p role="status">正在生成排版预览…</p> : null}
    {preview && !preview.coverConfigured && !preview.hasDraft && <p>尚未配置默认封面，请在专题 publish.defaultThumbMediaId 填写已有永久素材 ID。</p>}
    {uncertain && <section className="wx-recovery"><p>请先核对公众号后台。可绑定已创建的草稿，或在确认未创建后重新推送。</p>
      <label>已有草稿 media_id <input disabled={busy} value={recoveryMediaId} onChange={event => setRecoveryMediaId(event.target.value)} /></label>
      <button disabled={busy || !recoveryMediaId.trim()} onClick={() => void push({ recoveryMediaId: recoveryMediaId.trim() })}>绑定并继续</button>
      <button disabled={busy} onClick={() => { if (window.confirm("确认已在公众号后台核对，之前没有创建成功？继续可能新建草稿。")) void push({ confirmAbsent: true }); }}>确认未创建，重新推送</button>
    </section>}
    {pushResult && <section className={`wx-push-result wx-push-result-${pushResult.state}`} role={pushResult.state === "error" ? "alert" : "status"}>
      <strong>{pushResult.title}</strong><p>{pushResult.detail}</p>
      {pushResult.mediaId && <p className="wx-push-media-id">草稿 ID：{pushResult.mediaId}</p>}
    </section>}
    {error && !pushResult && <p className="wx-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <footer><button disabled={!preview || busy || changed} onClick={() => void copy()}>复制排版正文</button>
      <button className="primary" disabled={!preview || busy || changed || (!preview.coverConfigured && !preview.hasDraft)} onClick={() => void push()}>
        {busy ? "正在推送…" : preview?.hasDraft ? "更新公众号草稿" : "推送到公众号草稿箱"}</button></footer>
  </dialog>;
}
