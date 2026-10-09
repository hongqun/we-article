"use client";

import { useEffect, useState } from "react";
import type { ManualEditSession } from "../lib/style-memory/effects";
import ChangeDiff from "./ChangeDiff";

const date = (value: string) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

// 编辑页按需读取当前项目的原始手工修改；先保存可把本轮编辑一并纳入连续时段。
export default function ManualEditHistory({ topicId, projectId, busy, saveBeforeInspect }: {
  topicId: string; projectId: string; busy: boolean; saveBeforeInspect: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<ManualEditSession[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { setOpen(false); setHistory([]); setError(""); }, [topicId, projectId]);
  async function inspect() {
    if (open) { setOpen(false); return; }
    setLoading(true); setError("");
    try {
      await saveBeforeInspect();
      const query = new URLSearchParams({ topicId, projectId });
      const response = await fetch(`/api/style-memory?${query}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setHistory(data.sessions); setOpen(true);
    } catch (error) { setError(error instanceof Error ? error.message : "手工编辑记录读取失败"); }
    finally { setLoading(false); }
  }
  return <section className="manual-edit-history" aria-label="手工编辑记录">
    <button disabled={busy || loading} onClick={() => void inspect()}>{loading ? "正在读取手工编辑…" : open ? "收起手工编辑记录" : "查看手工编辑记录"}</button>
    {error && <p role="alert">{error}</p>}
    {open && <div className="manual-edit-history-content">
      <p className="overview-diff-legend"><ins>新增</ins><del>删除</del><span>本轮手工编辑已合并，反馈、生成或恢复会开启下一轮</span></p>
      {history.length ? history.map(session => <details key={session.id} open>
        <summary>连续手工编辑 · {date(session.startedAt)}{session.finishedAt !== session.startedAt ? ` 至 ${date(session.finishedAt)}` : ""} · {session.savedCount} 次保存</summary>
        <p className="overview-evidence-label">修改差异</p><ChangeDiff before={session.before} after={session.after} />
        <details><summary>查看完整前后文本</summary><p className="overview-evidence-label">修改前</p><pre>{session.before || "（空）"}</pre><p className="overview-evidence-label">修改后</p><pre>{session.after || "（无新文本）"}</pre></details>
      </details>) : <p className="hint">还没有已保存的正文手工编辑。</p>}
    </div>}
  </section>;
}
