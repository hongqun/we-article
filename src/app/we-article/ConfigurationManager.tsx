"use client";

import { useEffect, useRef, useState } from "react";
import type { ConfigurationSession, WritingAccount, WritingConfiguration } from "../../lib/we-article/types";
import Modal from "./WorkspaceModal";
import MessageMarkdown from "./MessageMarkdown";
import { json } from "./client";
import styles from "./workspace.module.css";

const sessionsApi = "/api/we-article/configuration/sessions";
const editable = (session: ConfigurationSession) => JSON.stringify({ draft: session.draft, accountId: session.accountId });
type Selection = { kind: "account" | "topic"; id: string };

// 管理目录、配置对话和草稿共用一个独立窗口，不混入文章对话。
export default function ConfigurationManager({ configuration, initialSession, onChanged, onExtract, onClose }: {
  configuration: WritingConfiguration; initialSession: ConfigurationSession | null;
  onChanged: () => Promise<unknown>; onExtract: (accountId: string | null) => void; onClose: () => void;
}) {
  const [selected, setSelected] = useState<Selection | null>(configuration.accounts[0] ? { kind: "account", id: configuration.accounts[0].id } : null);
  const [session, setSession] = useState<ConfigurationSession | null>(initialSession);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [returnToTopic, setReturnToTopic] = useState<string | null>(null);
  const operation = useRef(false);
  const started = useRef(false);
  const baseline = useRef(initialSession ? editable(initialSession) : "");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const dirty = Boolean(session && editable(session) !== baseline.current);
  const detailTopic = selected?.kind === "topic" ? configuration.topics.find(item => item.id === selected.id) : undefined;
  const detail = selected?.kind === "account" ? configuration.accounts.find(item => item.id === selected.id) : detailTopic;
  const currentAccountId = session?.kind === "topic" ? session.accountId
    : selected?.kind === "account" ? selected.id : configuration.topics.find(item => item.id === selected?.id)?.accountId ?? null;

  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: "nearest" }); }, [session?.messages.length]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || busy || input.trim()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy, input]);
  // 提炼入口创建好草稿后，在独立配置对话中开始归纳；严格模式不重复发送。
  useEffect(() => {
    if (initialSession?.sources.length && !initialSession.messages.length && !started.current) {
      started.current = true;
      void send("请从所选文章提炼一个可复用的专题，先整理配置草稿。只有一篇文章时请将归纳的规则作为建议。");
    }
  }, [initialSession]); // eslint-disable-line react-hooks/exhaustive-deps

  function adopt(value: ConfigurationSession | null) {
    setSession(value); baseline.current = value ? editable(value) : "";
  }
  async function perform(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { operation.current = false; setBusy(false); }
  }
  async function persist() {
    if (session && dirty) {
      const value = await json<ConfigurationSession>(`${sessionsApi}/${session.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: editable(session),
      });
      adopt(value);
    }
  }
  function discardInput() {
    if (input.trim() && !window.confirm("放弃尚未发送的配置描述？已整理的草稿会保留。")) return false;
    setInput(""); return true;
  }
  async function start(kind: "account" | "topic", accountId: string | null, targetId: string | null = null, returnToCurrent = false) {
    if (!discardInput()) return;
    await perform(async () => {
      await persist();
      setReturnToTopic(returnToCurrent ? session?.id ?? null : null);
      adopt(await json<ConfigurationSession>(sessionsApi, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, accountId, targetId }) }));
      await onChanged();
    });
  }
  async function openDetail(selection: Selection) {
    if (!discardInput()) return;
    await perform(async () => { await persist(); adopt(null); setReturnToTopic(null); setSelected(selection); await onChanged(); });
  }
  async function openSession(id: string) {
    if (!discardInput()) return;
    await perform(async () => { await persist(); adopt(await json<ConfigurationSession>(`${sessionsApi}/${id}`)); setReturnToTopic(null); });
  }
  async function send(instruction = input) {
    if (!session || !instruction.trim()) return;
    await perform(async () => {
      try {
        const value = await json<ConfigurationSession>(`${sessionsApi}/${session.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "message", draft: session.draft, accountId: session.accountId, instruction: instruction.trim() }) });
        adopt(value); setInput(""); await onChanged();
      } catch (cause) {
        // 模型失败时恢复服务端已保存的用户描述和手改草稿。
        const value = await json<ConfigurationSession>(`${sessionsApi}/${session.id}`).catch(() => null);
        if (value) adopt(value);
        throw cause;
      }
    });
  }
  async function confirm() {
    if (!session || !discardInput()) return;
    await perform(async () => {
      const saved = await json<WritingAccount>(`${sessionsApi}/${session.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", draft: session.draft, accountId: session.accountId }) });
      await onChanged();
      if (session.kind === "account" && returnToTopic) {
        const topicSession = await json<ConfigurationSession>(`${sessionsApi}/${returnToTopic}`);
        adopt(await json<ConfigurationSession>(`${sessionsApi}/${returnToTopic}`, { method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ draft: topicSession.draft, accountId: saved.id }) }));
        setReturnToTopic(null);
      } else { setSelected({ kind: session.kind, id: saved.id }); adopt(null); }
      setInput(""); setNotice(`已保存“${saved.name}”。`);
    });
  }
  async function close() {
    if (busy || !discardInput()) return;
    await perform(async () => { await persist(); await onChanged(); onClose(); });
  }
  async function extract() {
    if (!discardInput()) return;
    await perform(async () => { await persist(); onExtract(currentAccountId); });
  }

  return <Modal label="configuration-manager-title" wide onClose={() => void close()}>
    <header className={styles.dialogHeader}><h2 id="configuration-manager-title">账号与专题</h2>
      <button type="button" disabled={busy} onClick={() => void close()}>返回写作</button></header>
    {error && <p className={styles.dialogError} role="alert">{error}</p>}
    {notice && <p className={styles.configurationNotice} role="status">{notice}</p>}
    <div className={styles.configurationManager}>
      <aside className={styles.configurationDirectory} aria-label="账号与专题目录">
        <button type="button" disabled={busy} onClick={() => void start("account", null)}>＋ 新建账号</button>
        {configuration.accounts.map(account => <div className={styles.accountGroup} key={account.id}>
          <button type="button" className={styles.accountName} aria-pressed={!session && selected?.id === account.id} disabled={busy}
            onClick={() => void openDetail({ kind: "account", id: account.id })}>{account.name}</button>
          {configuration.topics.filter(topic => topic.accountId === account.id).map(topic => <button type="button" key={topic.id}
            aria-pressed={!session && selected?.id === topic.id} disabled={busy} onClick={() => void openDetail({ kind: "topic", id: topic.id })}>{topic.name}</button>)}
          <button type="button" disabled={busy} onClick={() => void start("topic", account.id)}>＋ 新建专题</button>
        </div>)}
        {configuration.sessions.length > 0 && <div className={styles.accountGroup}><h3>配置草稿</h3>
          {configuration.sessions.map(item => <button type="button" key={item.id} disabled={busy} aria-pressed={session?.id === item.id}
            onClick={() => void openSession(item.id)}>{item.name || `未命名${item.kind === "account" ? "账号" : "专题"}`}</button>)}
        </div>}
      </aside>
      {session ? <div className={styles.configurationEditing}>
        <section className={styles.configurationChat} aria-label="配置对话">
          <h3>{session.kind === "account" ? "账号配置对话" : "专题配置对话"}</h3>
          <div className={styles.configurationMessages}>
            {!session.messages.length && <p>描述你的定位、读者或写作想法，也可以直接在右侧填写。</p>}
            {session.messages.map((message, index) => <div key={index} className={`${styles.message} ${message.role === "user" ? styles.user : styles.assistant}`}>
              <span className={styles.messageRole}>{message.role === "user" ? "你" : "We-Article"}</span><MessageMarkdown content={message.content} />
            </div>)}<div ref={messagesEnd} />
          </div>
          <form className={styles.configurationComposer} onSubmit={event => { event.preventDefault(); void send(); }}>
            <textarea aria-label="配置描述" placeholder="补充你的想法……" value={input} maxLength={20000} disabled={busy} onChange={event => setInput(event.target.value)} />
            <button type="submit" className={styles.primary} disabled={busy || !input.trim()}>{busy ? "整理中…" : "发送"}</button>
          </form>
        </section>
        <section className={styles.configurationDraft} aria-label="配置草稿">
          <h3>{session.kind === "account" ? "账号" : "专题草稿"}</h3>
          <div className={styles.configurationFields}>
            <label>名称<input value={session.draft.name} disabled={busy} maxLength={100} onChange={event => setSession({ ...session, draft: { ...session.draft, name: event.target.value } })} /></label>
            {session.kind === "topic" && <label>所属账号<select value={session.accountId ?? ""} disabled={busy || Boolean(session.targetId)}
              onChange={event => setSession({ ...session, accountId: event.target.value || null })}>
              <option value="">请选择账号</option>{configuration.accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>{!session.targetId && <button type="button" disabled={busy} onClick={() => void start("account", null, null, true)}>＋ 新建账号</button>}</label>}
          </div>
          {session.sources.length > 0 && <details className={styles.configurationSources}><summary>根据 {session.sources.length} 篇文章提炼 · 查看来源</summary>
            {session.sources.map(source => <details key={source.id}><summary>{source.title}</summary><MessageMarkdown content={source.body} /></details>)}
          </details>}
          <label className={styles.configurationContentLabel}>写作要求
            <textarea value={session.draft.content} aria-label="配置写作要求" maxLength={20000} disabled={busy}
              placeholder={session.kind === "account" ? "定位、目标读者、共用写法与禁忌……" : "专题方向、文章形态、结构与特殊要求……"}
              onChange={event => setSession({ ...session, draft: { ...session.draft, content: event.target.value } })} />
          </label>
          <footer className={styles.dialogActions}><span>{dirty ? "草稿有修改" : "草稿已保留"}</span>
            <button type="button" disabled={busy || !dirty} onClick={() => void perform(async () => { await persist(); await onChanged(); })}>保留草稿</button>
            <button type="button" className={styles.primary} disabled={busy || !session.draft.name.trim() || !session.draft.content.trim() || (session.kind === "topic" && !session.accountId)}
              onClick={() => void confirm()}>确认保存</button>
          </footer>
        </section>
      </div> : detail ? <section className={styles.configurationDetail}>
        <header><h3>{detail.name}</h3><button type="button" disabled={busy} onClick={() => void start(selected!.kind, currentAccountId, detail.id)}>编辑{selected?.kind === "account" ? "账号" : "专题"}</button></header>
        {selected?.kind === "topic" && <p>所属账号：{configuration.accounts.find(account => account.id === currentAccountId)?.name}</p>}
        <div className={styles.markdown}><MessageMarkdown content={detail.content} /></div>
        {detailTopic && detailTopic.sources.length > 0 && <details className={styles.configurationSources}><summary>提炼来源 · {detailTopic.sources.length} 篇文章</summary>
          {detailTopic.sources.map(source => <details key={source.id}><summary>{source.title}</summary><MessageMarkdown content={source.body} /></details>)}
        </details>}
        {selected?.kind === "account" && <div className={styles.topicCards}><h3>专题</h3>
          {configuration.topics.filter(topic => topic.accountId === detail.id).map(topic => <button type="button" key={topic.id} disabled={busy}
            onClick={() => void openDetail({ kind: "topic", id: topic.id })}>{topic.name}</button>)}
          <button type="button" disabled={busy} onClick={() => void start("topic", detail.id)}>＋ 新建专题</button>
        </div>}
        <footer className={styles.dialogActions}><button type="button" disabled={busy} onClick={() => void extract()}>从文章提炼专题</button></footer>
      </section> : <section className={styles.configurationDetail}><h3>为长期写作建立配置</h3><p>用自然语言描述账号，也可以从已有文章提炼专题。</p>
        <div className={styles.dialogActions}><button type="button" disabled={busy} onClick={() => void extract()}>从文章提炼专题</button>
          <button type="button" className={styles.primary} disabled={busy} onClick={() => void start("account", null)}>新建账号</button></div>
      </section>}
    </div>
  </Modal>;
}
