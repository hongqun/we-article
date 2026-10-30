"use client";

import { useState } from "react";
import type { ArticleSelection, WritingConfiguration } from "../../lib/we-article/types";
import Modal from "./WorkspaceModal";
import MessageMarkdown from "./MessageMarkdown";
import styles from "./workspace.module.css";

// 不预选账号；用户可只选账号、选择其专题或全部跳过。
export default function ConfigurationPicker({ configuration, initial, changing, busy, error, onClose, onChoose }: {
  configuration: WritingConfiguration; initial?: ArticleSelection; changing: boolean; busy: boolean; error: string;
  onClose: () => void; onChoose: (selection: ArticleSelection) => void;
}) {
  const [accountId, setAccountId] = useState(initial?.accountId ?? "");
  const [topicId, setTopicId] = useState(initial?.topicId ?? "");
  const account = configuration.accounts.find(item => item.id === accountId);
  const topic = configuration.topics.find(item => item.id === topicId);
  return <Modal label="configuration-choice-title" onClose={() => { if (!busy) onClose(); }}>
    <header className={styles.dialogHeader}><h2 id="configuration-choice-title">{changing ? "文章使用的配置" : "新建文章"}</h2>
      <button type="button" disabled={busy} onClick={onClose} aria-label="关闭配置选择">×</button></header>
    <div className={styles.configurationFields}>
      <label>账号<select value={accountId} disabled={busy} onChange={event => { setAccountId(event.target.value); setTopicId(""); }}>
        <option value="">不选择账号</option>{configuration.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>专题<select value={topicId} disabled={busy || !accountId} onChange={event => setTopicId(event.target.value)}>
        <option value="">不选择专题</option>{configuration.topics.filter(item => item.accountId === accountId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    <div className={styles.configurationSummary}>
      {account ? <><strong>{account.name}{topic ? ` / ${topic.name}` : ""}</strong>
        <p>{(topic?.content ?? account.content).replace(/[#*_`]/g, "").replace(/\s+/g, " ").slice(0, 160)}</p>
        <details><summary>账号要求</summary><MessageMarkdown content={account.content} /></details>
        {topic && <details open><summary>专题要求</summary><MessageMarkdown content={topic.content} /></details>}</> : "使用通用写作规则，也可以在写作时提出具体要求。"}
    </div>
    {error && <p className={styles.dialogError} role="alert">{error}</p>}
    <footer className={styles.dialogActions}>
      <button type="button" disabled={busy} onClick={() => onChoose({ accountId: null, topicId: null })}>{changing ? "改为通用写作" : "跳过，通用写作"}</button>
      <button type="button" className={styles.primary} disabled={busy} onClick={() => onChoose({ accountId: accountId || null, topicId: topicId || null })}>
        {busy ? "处理中…" : changing ? "使用此配置" : "创建文章"}</button>
    </footer>
  </Modal>;
}
