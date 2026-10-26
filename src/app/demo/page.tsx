"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./demo.module.css";

// Demo 只复用 Markdown 编辑器，不连接文章工作台的项目或保存接口。
const MaterialAnalysisEditor = dynamic(() => import("../MaterialAnalysisEditor"), {
  ssr: false,
  loading: () => <div className={styles.editorLoading}>正在打开演示编辑器…</div>,
});

const storageKey = "we-article:mvp-demo:v1";
const demoTopic = "好用的 AI 小工具，为什么不一定能成为好生意？";
const starterInstruction = `我想写一篇关于「${demoTopic}」的文章。先给一个清楚的判断，再用普通读者能理解的方式展开。`;

type DemoMessage = { id: string; role: "user" | "assistant"; content: string };
type DemoState = {
  messages: DemoMessage[];
  article: string;
  confirmed: boolean;
  revisionCount: number;
};

const firstDraft = `# ${demoTopic}

一个小工具做得顺手，解决了真实问题，用户自然愿意留下来。但“好用”回答的是产品能不能帮上忙，“好生意”还要回答用户愿不愿意持续付费，以及团队能不能长期把服务做好。

很多 AI 工具的演示很亮眼，真正进入日常工作后，用户却会发现它只完成了流程里的一小步。省下来的时间如果不足以抵过学习、检查和订阅成本，体验再新鲜，也很难变成稳定需求。

所以，做产品不能只问“它能做什么”，还要看它是否进入了用户原本的工作习惯。能持续解决一个具体问题，才有机会从好用走到可持续。`;

const revisedDraft = `# 好用的 AI 小工具，为什么不一定能成为好生意？

一个工具好不好用，看它能不能解决问题；能不能成为好生意，还要看用户愿不愿意一直用、一直付费。两件事有关，却不是一回事。

AI 产品的演示常常很惊艳，但用户每天面对的是重复的工作。若工具只替人做完一小步，之后还得花时间核对、修补，省下来的时间就未必抵得过学习和订阅的成本。

产品要走得长，关键不是功能看起来多新，而是它能不能稳稳接进一个真实习惯。把小问题长期解决好，才可能从“挺好用”走到“值得付费”。`;

const focusedDraft = `# 好用的 AI 小工具，为什么不一定能成为好生意？

工具好用，说明它解决了问题；成为生意，还得让用户愿意持续付费。两者之间，隔着一个更实际的问题：它能不能稳定地融进日常工作。

一次演示能让人惊喜，长期使用却要算清成本。如果用户还要花时间学习、检查和修补，省下来的时间不够多，功能再新也很难成为习惯。

好产品不只展示“能做什么”，还要持续替用户解决一件具体的小事。做到这一点，才有机会从好用变成值得付费。`;

function isDemoMessage(value: unknown): value is DemoMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<DemoMessage>;
  return typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string";
}

function readDemoState(): DemoState | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<DemoState>;
    if (!Array.isArray(state.messages) || !state.messages.every(isDemoMessage) ||
      typeof state.article !== "string" || typeof state.confirmed !== "boolean" ||
      !Number.isInteger(state.revisionCount) || (state.revisionCount ?? -1) < 0) {
      window.localStorage.removeItem(storageKey);
      return null;
    }
    return state as DemoState;
  } catch {
    // 浏览器禁用本地存储或缓存损坏时，Demo 仍可从空白状态使用。
    try { window.localStorage.removeItem(storageKey); } catch { /* 存储不可用时忽略 */ }
    return null;
  }
}

function createMessage(role: DemoMessage["role"], content: string): DemoMessage {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, content };
}

export default function DemoPage() {
  const [state, setState] = useState<DemoState | null>(null);
  const [ready, setReady] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [mobileView, setMobileView] = useState<"conversation" | "article">("conversation");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setState(readDemoState());
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      if (state) window.localStorage.setItem(storageKey, JSON.stringify(state));
      else window.localStorage.removeItem(storageKey);
    } catch {
      // 原型可在无本地存储权限的浏览器中继续使用，只是不保留刷新状态。
    }
  }, [ready, state]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state?.messages.length]);

  function startDemo(goal: string) {
    const trimmedGoal = goal.trim() || starterInstruction;
    setState({
      messages: [
        createMessage("user", trimmedGoal),
        createMessage("assistant", `我先用一个虚构话题演示写作协作。当前建议的判断是：工具好用，和它能否成为可持续的生意，是两个需要分别回答的问题。右侧先放一版示例文章，你可以继续给我修改意见，也可以直接编辑。`),
      ],
      article: firstDraft,
      confirmed: false,
      revisionCount: 0,
    });
    setInstruction("");
    setMobileView("article");
  }

  function sendInstruction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed) return;
    if (!state) {
      startDemo(trimmed);
      return;
    }

    const revision = state.revisionCount === 0 ? revisedDraft : focusedDraft;
    const response = state.revisionCount === 0
      ? "我把论点收紧了，也删掉了一些重复解释。右侧已换成预设的修订稿，方便你检查反馈和文章如何关联。"
      : "我再把表达压短一些，并保留核心判断。右侧显示另一份固定演示稿；真实版本会由 Agent 根据你的要求生成。";
    setState({
      ...state,
      messages: [...state.messages, createMessage("user", trimmed), createMessage("assistant", response)],
      article: revision,
      confirmed: false,
      revisionCount: state.revisionCount + 1,
    });
    setInstruction("");
    setMobileView("article");
  }

  function resetDemo() {
    if (!window.confirm("清空这次演示的对话和正文？")) return;
    try { window.localStorage.removeItem(storageKey); } catch { /* 存储不可用时仍重置页面 */ }
    setState(null);
    setInstruction("");
    setMobileView("conversation");
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <Image src="/logo-mark.svg" alt="" width={38} height={38} priority />
          <div>
            <p className={styles.eyebrow}>WE-ARTICLE · INTERACTION STUDY</p>
            <h1>写作协作 Demo</h1>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.demoBadge}><span aria-hidden="true" />模拟演示</span>
          <Link className={styles.backLink} href="/">返回工作台</Link>
          <button className={styles.resetButton} type="button" onClick={resetDemo}>重置演示</button>
        </div>
      </header>

      <section className={styles.contextBar} aria-label="演示说明">
        <div className={styles.contextMark} aria-hidden="true">A</div>
        <div className={styles.contextCopy}>
          <strong>{state ? "正在试写" : "先试一段写作协作"}</strong>
          <span>{state ? demoTopic : "用虚构话题体验助手对话、文章修改和手工编辑。"}</span>
        </div>
        <p className={styles.simulationNote}>回复与修订稿均为固定示例，不代表真实 AI 生成</p>
      </section>

      {!ready ? <div className={styles.loading} role="status">正在打开演示…</div> : (
        <section className={`${styles.workspace} ${mobileView === "article" ? styles.showArticle : styles.showConversation}`} aria-label="写作演示工作区">
          <section className={styles.conversation} aria-label="写作助手对话">
            <header className={styles.panelHeader}>
              <div><span className={styles.panelKicker}>对话</span><h2>写作助手</h2></div>
              <span className={styles.mockLabel}>固定示例</span>
            </header>
            <div className={styles.messageList} aria-live="polite">
              {!state ? (
                <div className={styles.emptyConversation}>
                  <span className={styles.emptyGlyph} aria-hidden="true">✳</span>
                  <h3>从一个想法开始</h3>
                  <p>写下你想讨论的话题。这个 Demo 会用预设内容展示对话和文章编辑的关系。</p>
                  <button className={styles.starterButton} type="button" onClick={() => startDemo(starterInstruction)}>
                    试用虚构科技话题 <span aria-hidden="true">↗</span>
                  </button>
                  <span className={styles.starterHint}>示例：{demoTopic}</span>
                </div>
              ) : state.messages.map((message, index) => (
                <article className={`${styles.message} ${message.role === "user" ? styles.userMessage : styles.assistantMessage}`} key={message.id}>
                  <div className={styles.messageMeta}>
                    <span>{message.role === "user" ? "你" : "写作助手"}</span>
                    {message.role === "assistant" && <span className={styles.replyTag}>模拟回复</span>}
                    <span className={styles.messageIndex}>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <p>{message.content}</p>
                </article>
              ))}
              <div ref={messagesEndRef} />
            </div>
            <form className={styles.composer} onSubmit={sendInstruction}>
              <label className={styles.srOnly} htmlFor="demo-instruction">写作目标或修改意见</label>
              <textarea
                id="demo-instruction"
                value={instruction}
                onChange={event => setInstruction(event.target.value)}
                placeholder={state ? "试试：把第二段写得更简洁一些…" : "描述你想写的内容…"}
                rows={3}
                maxLength={1200}
              />
              <div className={styles.composerFooter}>
                <span>Enter 发送 · Shift + Enter 换行</span>
                <button className={styles.sendButton} type="submit" disabled={!instruction.trim()}>
                  {state ? "提交修改" : "开始演示"}<span aria-hidden="true">↑</span>
                </button>
              </div>
            </form>
          </section>

          <section className={styles.articlePanel} aria-label="演示文章编辑器">
            <header className={styles.articleHeader}>
              <div className={styles.articleTitleGroup}>
                <span className={styles.panelKicker}>当前稿件 <i aria-hidden="true" /></span>
                <h2>{state ? "文章正文" : "等待开始"}</h2>
              </div>
              <div className={styles.articleActions}>
                {state?.confirmed && <span className={styles.confirmedLabel}>已确认这版</span>}
                <button className={styles.confirmButton} type="button" disabled={!state?.article} onClick={() => state && setState({ ...state, confirmed: true })}>
                  {state?.confirmed ? "已确认" : "确认这版"}
                </button>
              </div>
            </header>
            <div className={styles.editorArea}>
              {state ? (
                <MaterialAnalysisEditor
                  key="mvp-demo-editor"
                  markdown={state.article}
                  onChange={article => setState(current => current ? { ...current, article, confirmed: false } : current)}
                />
              ) : (
                <div className={styles.emptyArticle}>
                  <span className={styles.paperCorner} aria-hidden="true" />
                  <span className={styles.emptyArticleLabel}>稿件预留区</span>
                  <h3>文章会在这里展开</h3>
                  <p>开始演示后，你可以直接改稿，也可以在左侧告诉助手希望怎么调整。</p>
                  <div className={styles.placeholderLines} aria-hidden="true"><i /><i /><i /><i /></div>
                </div>
              )}
            </div>
            <footer className={styles.articleFooter}>
              <span>{state ? `${state.article.trim().length.toLocaleString("zh-CN")} 字符 · 可直接编辑` : "Markdown 编辑器"}</span>
              <span>演示数据仅保存在本浏览器</span>
            </footer>
          </section>
        </section>
      )}

      <nav className={styles.mobileTabs} aria-label="切换演示面板">
        <button type="button" className={mobileView === "conversation" ? styles.activeTab : ""} aria-pressed={mobileView === "conversation"} onClick={() => setMobileView("conversation")}>对话</button>
        <button type="button" className={mobileView === "article" ? styles.activeTab : ""} aria-pressed={mobileView === "article"} onClick={() => setMobileView("article")}>文章</button>
      </nav>
    </main>
  );
}
