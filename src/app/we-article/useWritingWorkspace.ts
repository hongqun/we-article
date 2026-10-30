"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Article, ArticleSelection, ArticleSummary, StreamEvent, WritingConfiguration } from "../../lib/we-article/types";
import { api, json } from "./client";

type Target = ({ kind: "new"; selection?: ArticleSelection } | { kind: "open"; id: string } | { kind: "empty" }) & { replace?: boolean };

// 集中管理文章、保存和对话操作，界面只负责展示与交互。
export function useWritingWorkspace() {
  const [article, setArticle] = useState<Article | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [instruction, setInstruction] = useState("");
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState("正在打开…");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [configuration, setConfiguration] = useState<WritingConfiguration>({ accounts: [], topics: [], sessions: [] });
  const [selectionIntent, setSelectionIntent] = useState<"new" | "send" | "change" | null>(null);
  const [pending, setPending] = useState<Target | null>(null);
  const [editing, setEditing] = useState<{ id: string; content: string; original: string } | null>(null);
  const [mobileView, setMobileView] = useState<"chat" | "article">("chat");
  const operation = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const conversation = useRef<HTMLDivElement>(null);
  const dirty = Boolean(article && (title !== article.title || body !== article.body));
  const messageDirty = Boolean(editing && editing.content !== editing.original);
  const locked = busy;

  const adopt = useCallback((value: Article | null) => {
    setArticle(value); setTitle(value?.title || ""); setBody(value?.body || "");
  }, []);
  const locationFor = (id?: string) => id ? `/we-article?id=${encodeURIComponent(id)}` : "/we-article";
  const refreshList = useCallback(async () => {
    const items = await json<ArticleSummary[]>(api);
    if (mounted.current) setArticles(items);
  }, []);
  const refreshConfiguration = useCallback(async () => {
    const value = await json<WritingConfiguration>("/api/we-article/configuration");
    if (mounted.current) setConfiguration(value);
    return value;
  }, []);

  // 初始化只读取已有文章，不因访问空页面而创建数据库记录。
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void (async () => {
      try {
        const id = new URLSearchParams(window.location.search).get("id");
        if (id) {
          const value = await json<Article>(`${api}/${encodeURIComponent(id)}`, { signal: abort.signal });
          if (!abort.signal.aborted) adopt(value);
        }
        await Promise.all([refreshList(), refreshConfiguration()]);
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "打开失败。");
      } finally {
        if (!abort.signal.aborted) { setBusy(false); setStatus(""); }
      }
    })();
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, [adopt, refreshList, refreshConfiguration]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || messageDirty || busy || instruction.trim()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, messageDirty, busy, instruction]);
  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: "smooth" });
  }, [article?.messages.length, status]);

  async function withBusy(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { operation.current = false; setBusy(false); setStatus(""); setReasoning(""); }
  }
  async function saveCurrent(): Promise<Article> {
    if (!article) throw new Error("请先新建文章。");
    if (!dirty) return article;
    setStatus("正在保存…");
    const saved = await json<Article>(`${api}/${article.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() || "未命名文章", body }),
    });
    adopt(saved);
    // 列表失败不能把已经成功的正文保存报告为失败。
    void refreshList().catch(() => {});
    return saved;
  }
  // 消息保存只替换服务端快照，不覆盖用户尚未保存的标题和正文。
  async function saveMessage() {
    if (!article || !editing) return;
    if (messageDirty) {
      const saved = await json<Article>(`${api}/${article.id}/messages/${editing.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editing.content }),
      });
      setArticle(saved);
      void refreshList().catch(() => {});
    }
    setEditing(null);
  }
  async function navigate(target: Target) {
    let next: Article | null = null;
    if (target.kind === "new") {
      // 先完成未保存检查，再弹出配置选择；取消选择时仍停留在原文。
      if (!target.selection && (await refreshConfiguration()).accounts.length) {
        setPending(null); setListOpen(false); setSelectionIntent("new"); return;
      }
      next = await json<Article>(api, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.selection ?? {}) });
    }
    if (target.kind === "open") next = await json<Article>(`${api}/${encodeURIComponent(target.id)}`);
    adopt(next); setEditing(null); setInstruction(""); setListOpen(false); setPending(null);
    window.history[target.replace ? "replaceState" : "pushState"]({}, "", locationFor(next?.id));
    await refreshList().catch(() => {});
  }
  function requestNavigation(target: Target) {
    if (busy || operation.current) return;
    if (dirty || messageDirty || instruction.trim()) setPending(target);
    else void withBusy(() => navigate(target));
  }
  // 浏览器前进后退同样经过未保存检查；先恢复当前地址，再处理目标文章。
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get("id");
      window.history.replaceState({}, "", locationFor(article?.id));
      requestNavigation(id ? { kind: "open", id, replace: true } : { kind: "empty", replace: true });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  async function send(selection?: ArticleSelection) {
    if (locked || editing || !instruction.trim()) return;
    await withBusy(async () => {
      let current: Article;
      if (article) current = await saveCurrent();
      else {
        // 首次发送先选择配置，退出弹窗不清空用户已输入的材料。
        if (!selection && (await refreshConfiguration()).accounts.length) { setSelectionIntent("send"); return; }
        current = await json<Article>(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection ?? {}) });
        adopt(current);
        window.history.replaceState({}, "", locationFor(current.id));
      }
      setSelectionIntent(null);
      const abort = new AbortController(); controller.current = abort;
      let completed = false;
      try {
        setStatus("正在连接…"); setReasoning("");
        const response = await fetch(`${api}/${current.id}/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
          body: JSON.stringify({ instruction: instruction.trim() }),
        });
        if (!response.ok) {
          const failure = await response.json();
          throw new Error(failure.error || "生成请求失败。");
        }
        if (!response.body) throw new Error("无法读取模型响应。");
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "";
        function receive(line: string) {
          if (!line.trim()) return;
          const event = JSON.parse(line) as StreamEvent;
          if (event.type === "status") { setStatus(event.message); setReasoning(""); }
          // 标题栏仅保留最近的推理片段，避免长时间生成时持续累积。
          if (event.type === "reasoning") setReasoning(current => (current + event.text).slice(-500));
          // 消息已进入对话后清空输入框，接受前失败则保留输入。
          if (event.type === "accepted") { adopt(event.article); setInstruction(""); }
          if (event.type === "done") { adopt(event.article); completed = true; }
          if (event.type === "error") throw new Error(event.message);
        }
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) { buffer += decoder.decode(); break; }
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n"); buffer = lines.pop() || "";
            for (const line of lines) receive(line);
          }
          receive(buffer);
          if (!completed) throw new Error("连接已中断，原稿已保留。请重新打开查看状态。");
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } finally {
        controller.current = null;
        // 只同步服务器状态，失败时保留尚未发送成功的输入文字。
        if (mounted.current) {
          try { adopt(await json<Article>(`${api}/${current.id}`)); } catch { /* 网络恢复后可重新打开。 */ }
          await refreshList().catch(() => {});
        }
      }
    });
  }
  async function chooseConfiguration(selection: ArticleSelection) {
    if (selectionIntent === "send") { await send(selection); return; }
    await withBusy(async () => {
      if (selectionIntent === "change" && article) {
        await saveCurrent();
        adopt(await json<Article>(`${api}/${article.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection) }));
        await refreshList();
      } else await navigate({ kind: "new", selection });
      setSelectionIntent(null);
    });
  }
  async function openConfigurationSelection() {
    await withBusy(async () => { await refreshConfiguration(); setSelectionIntent("change"); });
  }

  return { article, title, setTitle, body, setBody, instruction, setInstruction, articles,
    busy, status, reasoning, error, setError, listOpen, setListOpen, pending, setPending,
    mobileView, setMobileView, conversation, dirty, locked, adopt, refreshList,
    editing, setEditing, messageDirty, saveMessage, withBusy, saveCurrent, navigate, requestNavigation, send,
    configuration, refreshConfiguration, selectionIntent, setSelectionIntent, chooseConfiguration, openConfigurationSelection };
}
