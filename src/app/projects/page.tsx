"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import AppNavigation from "../AppNavigation";
import DeleteProjectDialog from "../DeleteProjectDialog";
import type { ProjectSummary, WritingTopicSummary } from "../../lib/project";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [topics, setTopics] = useState<WritingTopicSummary[]>([]);
  const [activeTopicId, setActiveTopicId] = useState("");
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([fetch("/api/projects", { cache: "no-store" }).then(r => r.json()), fetch("/api/topics", { cache: "no-store" }).then(r => r.json())])
      .then(([projectData, topicData]) => {
        setProjects(projectData); setTopics(topicData);
        // 首次进入默认展示第一个专题，避免两个列表同时占据页面。
        setActiveTopicId(topicData[0]?.id ?? "");
      })
      .catch(() => setError("文章列表读取失败，请刷新后重试。"));
  }, []);
  const groups = useMemo(() => topics.map(topic => ({ topic, projects: projects.filter(project => project.topicId === topic.id) })), [projects, topics]);
  const activeGroup = groups.find(group => group.topic.id === activeTopicId) ?? groups[0];
  function moveTab(currentIndex: number, direction: -1 | 1) {
    const next = groups[(currentIndex + direction + groups.length) % groups.length];
    if (!next) return;
    setActiveTopicId(next.topic.id);
    // 方向键切换时同步移动焦点，符合 Tab 组件的键盘操作预期。
    document.getElementById(`project-tab-${next.topic.id}`)?.focus();
  }
  async function remove(id: string) {
    setError("");
    const response = await fetch(`/api/projects?id=${id}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) { setError(data.error || "删除失败，请重试。"); throw new Error(data.error); }
    setProjects(items => items.filter(item => item.id !== id));
  }
  return <main className="management-page">
    <header className="topbar"><div className="brand"><span className="brand-mark">文</span><div><h1>文章管理</h1><p>按专题查看、打开或删除已保存的文章。</p></div></div><AppNavigation /></header>
    {error && <p className="error" role="alert">{error}</p>}
    {activeGroup && <section className="project-groups" aria-label="按专题筛选文章列表">
      <div className="project-tabs" role="tablist" aria-label="文章专题">
        {groups.map(({ topic, projects: items }, index) => <button key={topic.id} id={`project-tab-${topic.id}`} type="button" role="tab"
          aria-selected={topic.id === activeGroup.topic.id} aria-controls={`project-panel-${topic.id}`} tabIndex={topic.id === activeGroup.topic.id ? 0 : -1}
          className={topic.id === activeGroup.topic.id ? "active" : ""} onClick={() => setActiveTopicId(topic.id)}
          onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); moveTab(index, -1); } if (event.key === "ArrowRight") { event.preventDefault(); moveTab(index, 1); } }}>
          {topic.name}<span>{items.length}</span>
        </button>)}
      </div>
      <section className="project-group" id={`project-panel-${activeGroup.topic.id}`} role="tabpanel" aria-labelledby={`project-tab-${activeGroup.topic.id}`}>
        <header><div><h2>{activeGroup.topic.name}</h2><p>{activeGroup.topic.description}</p></div><span>{activeGroup.projects.length} 篇</span></header>
        {activeGroup.projects.length ? <ul>{activeGroup.projects.map(item => <li key={item.id}><div><h3>{item.title}</h3><p>最近更新：{new Date(item.updatedAt).toLocaleString("zh-CN")}</p></div><div className="project-row-actions"><button onClick={() => router.push(`/?projectId=${item.id}`)}>打开</button><button className="danger" onClick={() => setRemoving(item)}>删除</button></div></li>)}</ul> : <p className="hint">这个专题还没有保存的文章。</p>}
      </section>
    </section>}
    <DeleteProjectDialog project={removing} onClose={() => setRemoving(null)} onConfirm={remove} />
  </main>;
}
