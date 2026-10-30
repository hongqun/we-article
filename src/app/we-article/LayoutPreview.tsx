"use client";
import { useEffect, useState } from "react";
import styles from "./workspace.module.css";
import { themeNames, type LayoutTheme } from "../../lib/we-article/layout-themes";

type Preview = { title: string; html: string };

// 预览随当前编辑快照更新，不影响正文保存状态。
export default function LayoutPreview({ title, body }: { title: string; body: string }) {
  const [theme, setTheme] = useState<LayoutTheme>("ink");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setPreview(null); setMessage("");
    if (!body.trim()) return;
    const controller = new AbortController();
    void fetch("/api/we-article/layout", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, theme }), signal: controller.signal })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result as Preview; })
      .then(setPreview).catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "排版失败。"); });
    return () => controller.abort();
  }, [title, body, theme]);
  async function copy() {
    if (!preview) return;
    try {
      const document = new DOMParser().parseFromString(preview.html, "text/html");
      document.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
      document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre").forEach(node => node.append("\n"));
      const text = document.body.textContent || "";
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([preview.html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      setMessage("已复制正文，请在公众号后台单独填写标题。");
    } catch { setMessage("复制失败，请检查浏览器剪贴板权限。"); }
  }
  return <div className={styles.layout}>
    <div className={styles.layoutControls}><label>样式 <select value={theme} onChange={event => setTheme(event.target.value as LayoutTheme)}>
      {Object.entries(themeNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <button type="button" disabled={!preview} onClick={() => void copy()}>复制排版正文</button></div>
    <p className={styles.layoutHint}>图片请在公众号后台添加；粘贴后请检查排版效果。</p>
    {message && <p className={styles.layoutHint} role="status">{message}</p>}
    {preview ? <div className={styles.previewPaper}><h1>{preview.title}</h1>
      <iframe title="公众号正文预览" sandbox="" srcDoc={`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="margin:0;padding:0 16px 24px">${preview.html}</body></html>`} /></div>
      : <div className={styles.layoutEmpty}>{body.trim() ? (message || "正在生成排版…") : "输入正文后可预览排版。"}</div>}
  </div>;
}
