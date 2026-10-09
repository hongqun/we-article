"use client";

import { useEffect, useState } from "react";
import AppNavigation from "../AppNavigation";
import StyleMemoryPanel from "../StyleMemoryPanel";
import type { WritingTopicSummary } from "../../lib/project";

export default function StyleMemoryPage() {
  const [topics, setTopics] = useState<WritingTopicSummary[]>([]);
  const [topicId, setTopicId] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch("/api/topics", { cache: "no-store" }).then(r => r.json()).then((items: WritingTopicSummary[]) => {
    const supported = items.filter(item => item.styleMemory); setTopics(supported); setTopicId(current => current || supported[0]?.id || "");
  }); }, []);
  const current = topics.find(topic => topic.id === topicId);
  return <main className="management-page">
    <header className="topbar"><div className="brand"><span className="brand-mark">文</span><div><h1>风格记忆</h1><p>查看并维护各专题从真实修改中形成的写作倾向。</p></div></div><AppNavigation /></header>
    {topics.length > 0 && <label className="memory-topic-picker">选择专题<select value={topicId} disabled={busy} onChange={event => setTopicId(event.target.value)}>{topics.map(topic => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>}
    {current ? <StyleMemoryPanel topicId={current.id} topicName={current.name} busy={busy} revision={topicId} onBusy={setBusy} saveBeforeSummary={async () => {}} /> : <p className="hint">当前没有启用风格记忆的专题。</p>}
  </main>;
}
