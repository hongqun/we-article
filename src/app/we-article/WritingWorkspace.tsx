"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useWritingWorkspace } from "./useWritingWorkspace";
import styles from "./workspace.module.css";

// 原生对话框提供焦点圈定、Escape 关闭和背景隔离。
function Modal({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={label}
    onCancel={event => { event.preventDefault(); onClose(); }}>{children}</dialog>;
}

// 独立写作页面展示当前文章和对话。
export default function WritingWorkspace() {
  const { article, title, setTitle, body, setBody, instruction, setInstruction, articles,
    busy, status, reasoning, error, setError, listOpen, setListOpen, pending, setPending,
    mobileView, setMobileView, conversation, dirty, locked, refreshList,
    withBusy, saveCurrent, navigate, requestNavigation, send } = useWritingWorkspace();
  const wordCount = Array.from(body.replace(/\s/g, "")).length;
  const reasoningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = reasoningRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [reasoning]);
  return <main className={styles.page}>
    <header className={styles.topbar}>
      <span className={styles.brand}>We-Article<span className={styles.brandDot} /></span>
      <input className={styles.title} aria-label="文章标题" placeholder="未命名文章" value={title}
        maxLength={200} disabled={!article || locked} onChange={event => setTitle(event.target.value)} />
      <div className={styles.actions}>
        <button type="button" disabled={locked} onClick={() => requestNavigation({ kind: "new" })}>新建</button>
        <button type="button" disabled={busy} onClick={() => setListOpen(true)}>打开</button>
        <button type="button" className={styles.primary} disabled={!article || !dirty || locked}
          onClick={() => void withBusy(async () => { await saveCurrent(); })}>保存</button>
      </div>
    </header>
    {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="关闭提示">×</button></div>}
    <div className={`${styles.workspace} ${mobileView === "article" ? styles.showArticle : styles.showChat}`}>
      <section className={`${styles.panel} ${styles.chatPanel}`} aria-label="写作对话" id="writing-chat">
        <header className={styles.panelHeader}><h1>写作对话</h1><div ref={reasoningRef} className={styles.activity}>
          {busy && (reasoning ? <span>{reasoning.replace(/\s+/g, " ")}</span> : <span aria-live="polite">{status || "处理中…"}</span>)}
        </div></header>
        <div className={styles.messages} ref={conversation}>
          {!article?.messages.length && <div className={styles.empty}><span className={styles.emptyMark}>W</span><h2>从一个想法开始</h2><p>粘贴材料，告诉我你想怎么写。</p></div>}
          {article?.messages.map(message => <div className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`} key={message.id}>
            <span className={styles.messageRole}>{message.role === "user" ? "你" : "We-Article"}</span><div>{message.content}</div>
          </div>)}
        </div>
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(); }}>
          <textarea aria-label="写作材料或修改要求" placeholder="输入材料、写作要求或修改意见…" rows={4}
            maxLength={50000} disabled={locked} value={instruction} onChange={event => setInstruction(event.target.value)} />
          <div className={styles.composerFooter}><span>{instruction.length ? `${instruction.length.toLocaleString()} / 50,000` : ""}</span>
            <button type="submit" className={styles.primary} disabled={locked || !instruction.trim()}>{busy ? "处理中…" : "发送 ↑"}</button></div>
        </form>
      </section>
      <section className={`${styles.panel} ${styles.articlePanel}`} aria-label="文章编辑器" id="writing-article">
        <header className={styles.panelHeader}><h2>文章正文</h2><span aria-live="polite">{dirty ? "未保存" : article ? "已保存" : "未开始"}</span></header>
        <div className={styles.editorWrap}><textarea className={styles.editor} aria-label="Markdown 正文" spellCheck={false}
          placeholder="正文将在这里出现" maxLength={200000} value={body} disabled={!article || locked}
          onChange={event => setBody(event.target.value)} /></div>
        <footer className={styles.documentFooter}><span>{wordCount.toLocaleString()} 字</span><span>Markdown</span></footer>
      </section>
    </div>
    <nav className={styles.mobileTabs} aria-label="切换工作区">
      <button type="button" aria-controls="writing-chat" aria-pressed={mobileView === "chat"} onClick={() => setMobileView("chat")}>对话</button>
      <button type="button" aria-controls="writing-article" aria-pressed={mobileView === "article"} onClick={() => setMobileView("article")}>正文</button>
    </nav>
    {listOpen && <Modal label="article-list-title" onClose={() => { if (!busy) setListOpen(false); }}>
      <header className={styles.dialogHeader}><h2 id="article-list-title">打开文章</h2><button type="button" onClick={() => setListOpen(false)} aria-label="关闭文章列表">×</button></header>
      <div className={styles.articleList}>{!articles.length && <p>还没有保存的文章。</p>}
        {articles.map(item => <button type="button" className={styles.articleItem} key={item.id} disabled={locked}
          onClick={() => requestNavigation({ kind: "open", id: item.id })}><strong>{item.title}</strong><time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString("zh-CN")}</time></button>)}
      </div>
      {error && <p className={styles.dialogError} role="alert">{error}</p>}
      <footer className={styles.dialogActions}><button type="button" disabled={busy} onClick={() => void withBusy(refreshList)}>刷新列表</button></footer>
    </Modal>}
    {pending && <Modal label="unsaved-title" onClose={() => { if (!busy) setPending(null); }}>
      <h2 id="unsaved-title">还有未保存的内容</h2><p>保存当前正文后切换？输入框中的文字将清空。</p>
      {error && <p className={styles.dialogError} role="alert">{error}</p>}
      <div className={styles.dialogActions}>
        <button type="button" disabled={busy} onClick={() => setPending(null)}>取消</button>
        <button type="button" disabled={busy} onClick={() => void withBusy(() => navigate(pending))}>放弃并切换</button>
        <button type="button" className={styles.primary} disabled={busy} onClick={() => void withBusy(async () => {
          if (article) await saveCurrent();
          await navigate(pending);
        })}>保存并切换</button>
      </div>
    </Modal>}
  </main>;
}
