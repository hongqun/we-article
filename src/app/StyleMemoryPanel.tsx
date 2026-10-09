"use client";

import { useEffect, useState } from "react";
import type { MemoryEvent, MemoryView, TrendStatus } from "../lib/style-memory/types";

const labels: Record<TrendStatus, string> = { observing: "观察中", active: "使用中", conflicted: "有相反修改，暂不使用", disabled: "已停用" };
const kindNames: Record<MemoryEvent["kind"], string> = { manual: "手动修改", feedback: "用户反馈", button: "按钮指令", model: "模型输出", restore: "恢复版本", context: "材料变化", correction: "用户修订倾向", usage: "写作使用记录" };
const runLabels: Record<string, string> = { running: "进行中", succeeded: "完成", failed: "失败" };
const date = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未总结";

// 面板按需展开，沿用工作台原有表单样式；证据全文仅在用户查看时请求。
export default function StyleMemoryPanel({ topicId, topicName, busy, revision, onBusy, saveBeforeSummary }: {
  topicId: string; topicName: string; busy: boolean; revision: string;
  onBusy: (value: boolean) => void; saveBeforeSummary: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MemoryView | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [evidence, setEvidence] = useState<MemoryEvent[]>([]);
  const [evidenceTrendId, setEvidenceTrendId] = useState("");
  const [loadingEvidence, setLoadingEvidence] = useState(false);
  const [historyId, setHistoryId] = useState("");
  const stageNames = { analysis: "材料解读", topics: "选题与方向", outline: "写作思路", article: "正文" };
  // 面板切换专题时清掉旧画像，等待新作用域的请求完成。
  useEffect(() => { setView(null); setEvidence([]); setEvidenceTrendId(""); setHistoryId(""); }, [topicId]);
  useEffect(() => {
    if (!open || busy) return;
    const abort = new AbortController();
    fetch(`/api/style-memory?topicId=${topicId}`, { cache: "no-store", signal: abort.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data as MemoryView; })
      .then(setView).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [open, revision, busy, topicId]);
  async function act(action: "summarize" | "correct" | "disable" | "restore", id?: string) {
    onBusy(true); setError(""); setMessage(action === "summarize" ? "正在整理近期修改…" : "正在保存…");
    try {
      if (action === "summarize") await saveBeforeSummary();
      const response = await fetch("/api/style-memory", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId, action, id, ...(action === "correct" ? { text } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setView(result.view); setMessage(result.ok ? result.message : ""); setError(result.ok ? "" : result.message);
      if (result.ok) setEditing("");
    } catch (error) { setError(error instanceof Error ? error.message : "操作失败"); setMessage(""); }
    finally { onBusy(false); }
  }
  async function inspect(trendId: string, ids: string[]) {
    setError(""); setLoadingEvidence(true);
    try {
      // 分页取证据，避免单条倾向积累较多后无法查看。
      const unique = [...new Set(ids)];
      const all: MemoryEvent[] = [];
      for (let i = 0; i < unique.length; i += 50) {
        const query = new URLSearchParams({ topicId });
        unique.slice(i, i + 50).forEach(id => query.append("eventId", id));
        const response = await fetch(`/api/style-memory?${query}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        all.push(...data.events);
      }
      // 证据紧跟触发它的倾向，避免长列表中把内容误认为没有展开。
      setEvidence(all); setEvidenceTrendId(trendId);
    } catch (error) { setError(error instanceof Error ? error.message : "证据读取失败"); }
    finally { setLoadingEvidence(false); }
  }
  const history = view?.versions.find(v => String(v.id) === historyId);
  return <details className="style-memory" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{topicName} · 风格记忆</summary>
    {open && <div className="style-memory-content">
      {/* 适用位置与证据来源分开展示，正文修改不伪装成用户审核过大纲。 */}
      <p className="hint">从题目和正文修改中提炼可复用的写作画像，正文修改也可指导选题与思路。保存、定稿和没有修改，都不表示满意。自动和手动更新每次整理一批，待整理历史可继续点击更新。</p>
      <div className="style-memory-actions">
        <span>上次总结：{date(view?.lastSuccess ?? null)} · 待整理：{view?.pendingCount ?? "—"} 条</span>
        <button disabled={busy} onClick={() => void act("summarize")}>更新风格记忆</button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p>正在读取…</p>}
      {view?.trends.length === 0 && <p className="hint">还没有形成风格倾向，继续正常写作和修改即可。</p>}
      {view?.trends.map(trend => <article className="style-memory-trend" key={trend.id}>
        <p className="hint">适用于{stageNames[trend.stage]} · {trend.scene} · {labels[trend.status]} · 支持 {trend.supportProjectCount ?? 0} 篇文章</p>
        {editing === trend.id ? <label>修订你的表达偏好<textarea aria-label="修订风格倾向" maxLength={240} value={text} disabled={busy} onChange={event => setText(event.target.value)} /></label> : <p>{trend.text}</p>}
        <div className="style-memory-actions">
          {editing === trend.id ? <><button disabled={busy || !text.trim()} onClick={() => void act("correct", trend.id)}>保存修订</button><button disabled={busy} onClick={() => setEditing("")}>取消</button></> :
            <button disabled={busy} onClick={() => { setEditing(trend.id); setText(trend.text); }}>纠正</button>}
          <button disabled={busy} onClick={() => void act(trend.status === "disabled" ? "restore" : "disable", trend.id)}>{trend.status === "disabled" ? "恢复使用" : "停用"}</button>
          <button disabled={busy || loadingEvidence} onClick={() => void inspect(trend.id, trend.evidence.map(e => e.eventId))}>查看依据（{trend.evidence.length}）</button>
        </div>
        {evidenceTrendId === trend.id && <section className="style-memory-evidence" aria-label="风格原始证据"><h3>原始修改依据</h3>
          <button onClick={() => { setEvidence([]); setEvidenceTrendId(""); }}>收起依据</button>
          {evidence.length ? evidence.map(event => <details key={event.id}><summary>来源：{stageNames[event.stage]} · {kindNames[event.kind]} · {event.title || "未选标题"} · {date(event.createdAt)}</summary>
            {event.instruction && <><p>当时的意见</p><pre>{event.instruction}</pre></>}
            <p>修改前</p><pre>{event.before || "（空）"}</pre><p>修改后</p><pre>{event.after || "（无新文本）"}</pre>
          </details>) : <p className="hint">关联的原始记录已不可用。</p>}
        </section>}
      </article>)}
      {Boolean(view?.versions.length) && <label>画像历史（最近 30 次，只读）
        <select value={historyId} onChange={event => setHistoryId(event.target.value)}><option value="">选择历史画像</option>
          {view?.versions.map(version => <option key={version.id} value={version.id}>{date(version.createdAt)} · {version.reason}</option>)}
        </select>
      </label>}
      {history && <div>{history.trends.length ? history.trends.map(trend => <p key={trend.id}>{labels[trend.status]} · {trend.text}</p>) : <p>此次未形成风格倾向。</p>}</div>}
      {Boolean(view?.runs.length) && <details><summary>最近整理记录</summary>
        {view?.runs.map(run => <p key={run.id}>{date(run.startedAt)} · {run.mode === "auto" ? "自动" : "手动"} · {runLabels[run.status] ?? run.status}{run.error ? `：${run.error}` : ""}</p>)}
      </details>}
    </div>}
  </details>;
}
