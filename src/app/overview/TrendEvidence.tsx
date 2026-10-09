"use client";

import { useState } from "react";
import type { MemoryEvent } from "../../lib/style-memory/types";
import ChangeDiff from "../ChangeDiff";

const stageNames: Record<MemoryEvent["stage"], string> = { analysis: "材料解读", topics: "选题与方向", outline: "写作大纲", article: "正文" };
const kindNames: Record<MemoryEvent["kind"], string> = { manual: "手动修改", feedback: "用户反馈", button: "按钮指令", model: "模型输出", restore: "恢复版本", context: "材料变化", correction: "用户修订倾向", usage: "写作使用记录" };

// 概览页按需取原始证据，避免把正文快照预先写入统计页面。
export default function TrendEvidence({ topicId, eventIds, evidenceCount }: {
  topicId: string; eventIds: string[]; evidenceCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<MemoryEvent[]>([]);
  const [error, setError] = useState("");
  async function inspect() {
    if (open) { setOpen(false); return; }
    setLoading(true); setError("");
    try {
      const all: MemoryEvent[] = [];
      const ids = [...new Set(eventIds)];
      for (let index = 0; index < ids.length; index += 50) {
        const query = new URLSearchParams({ topicId });
        ids.slice(index, index + 50).forEach(id => query.append("eventId", id));
        const response = await fetch(`/api/style-memory?${query}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        all.push(...data.events);
      }
      setEvents(all); setOpen(true);
    } catch (error) { setError(error instanceof Error ? error.message : "证据读取失败"); }
    finally { setLoading(false); }
  }
  return <div className="overview-evidence-control">
    <button disabled={loading} onClick={() => void inspect()}>{loading ? "正在读取依据…" : open ? "收起依据" : `查看依据（${evidenceCount}）`}</button>
    {error && <p role="alert">{error}</p>}
    {open && <section className="overview-evidence" aria-label="原始修改依据">
      <p className="overview-diff-legend"><ins>新增</ins><del>删除</del><span>未标色部分为保留内容</span></p>
      {events.length ? events.map(event => <details key={event.id} open>
        <summary>{stageNames[event.stage]} · {kindNames[event.kind]} · {event.title || "未选标题"}</summary>
        {event.instruction && <p className="overview-evidence-instruction">当时的意见：{event.instruction}</p>}
        <p className="overview-evidence-label">修改差异</p><ChangeDiff before={event.before} after={event.after} />
        <details><summary>查看完整前后文本</summary><p className="overview-evidence-label">修改前</p><pre>{event.before || "（空）"}</pre><p className="overview-evidence-label">修改后</p><pre>{event.after || "（无新文本）"}</pre></details>
      </details>) : <p>关联的原始记录已不可用。</p>}
    </section>}
  </div>;
}
