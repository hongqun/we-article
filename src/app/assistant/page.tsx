"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import AppNavigation from "../AppNavigation";
import styles from "./assistant.module.css";

// 阶段顺序沿用工作台现有流程；本页先呈现入口和工作区框架。
const writingStages = [
  { title: "材料解读" },
  { title: "选题与方向" },
  { title: "写作大纲" },
  { title: "正文与成稿" },
] as const;

type WorkspaceView = "assistant" | "article";

function WorkflowSteps() {
  return (
    <nav className={styles.workflow} aria-label="写作流程">
      <ol>
        {writingStages.map((stage, index) => (
          <li className={index === 0 ? styles.currentStep : ""} key={stage.title} aria-current={index === 0 ? "step" : undefined}>
            <span className={styles.stepIndex} aria-hidden="true">0{index + 1}</span>
            <span className={styles.stepText}>
              <strong>{stage.title}</strong>
            </span>
            {index < writingStages.length - 1 && <span className={styles.stepConnector} aria-hidden="true" />}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function AssistantPanel() {
  return (
    <section className={`${styles.panel} ${styles.assistantPanel}`} aria-label="写作助手对话" role="region" id="assistant-panel">
      <header className={styles.panelHeader}>
        <div>
          <h2>写作助手</h2>
        </div>
        <span className={styles.waitingStatus}><i aria-hidden="true" />等待开始</span>
      </header>

      <div className={styles.conversationBody}>
        <div className={styles.emptyConversation}>
          <Image className={styles.assistantMark} src="/logo-mark.svg" alt="" width={42} height={42} />
          <h3>开始写作</h3>
          <p className={styles.emptyDescription}>材料 · 想法 · 修改意见</p>
        </div>
      </div>

      <form className={styles.composer} aria-label="写作助手输入区">
        <textarea
          id="assistant-message"
          aria-label="写作材料或要求"
          disabled
          rows={3}
          placeholder="输入材料或要求"
        />
        <div className={styles.composerFooter}>
          <button type="button" disabled>发送 <span aria-hidden="true">↑</span></button>
        </div>
      </form>
    </section>
  );
}

function ArticlePanel() {
  return (
    <section className={`${styles.panel} ${styles.articlePanel}`} aria-label="文章稿件" role="region" id="article-panel">
      <header className={styles.panelHeader}>
        <div>
          <h2>文章正文</h2>
        </div>
        <div className={styles.documentStatus}>
          <span>Markdown</span>
          <i aria-hidden="true" />
          <span>未开始</span>
        </div>
      </header>

      <div className={styles.documentScroll}>
        <article className={styles.paper}>
          <div className={styles.paperLabel}>
            <span>稿件画布</span>
            <span>WE-ARTICLE / DRAFT</span>
          </div>
          <div className={styles.emptyDocument}>
            <span className={styles.documentRule} aria-hidden="true" />
            <h3>文章将在这里出现</h3>
          </div>
          <div className={styles.paperLines} aria-hidden="true"><i /><i /><i /><i /><i /></div>
        </article>
      </div>

      <footer className={styles.documentFooter}>
        <span>0 字</span>
      </footer>
    </section>
  );
}

export default function AssistantPage() {
  const [mobileView, setMobileView] = useState<WorkspaceView>("assistant");

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="We-Article 写作工作台">
          <Image src="/logo-mark.svg" alt="" width={38} height={38} priority />
          <span className={styles.brandName}>We-Article</span>
          <span className={styles.brandDivider} aria-hidden="true">/</span>
          <span className={styles.brandPage}>写作助手</span>
        </Link>
        <div className={styles.navigation}><AppNavigation /></div>
      </header>

      <section className={styles.pageHeading} aria-labelledby="page-title">
        <div>
          <h1 id="page-title">写作助手</h1>
        </div>
        <Link className={styles.projectLink} href="/projects">
          <span>当前文章</span>
          <strong>选择或新建文章</strong>
          <span className={styles.projectArrow} aria-hidden="true">↗</span>
        </Link>
      </section>

      <WorkflowSteps />

      <section
        className={`${styles.workspace} ${mobileView === "article" ? styles.showArticle : styles.showAssistant}`}
        aria-label="写作助手工作区"
      >
        <AssistantPanel />
        <ArticlePanel />
      </section>

      <nav className={styles.mobileTabs} aria-label="切换工作区面板">
        <button
          type="button"
          aria-controls="assistant-panel"
          aria-pressed={mobileView === "assistant"}
          className={mobileView === "assistant" ? styles.activeTab : ""}
          onClick={() => setMobileView("assistant")}
        >
          对话
        </button>
        <button
          type="button"
          aria-controls="article-panel"
          aria-pressed={mobileView === "article"}
          className={mobileView === "article" ? styles.activeTab : ""}
          onClick={() => setMobileView("article")}
        >
          文章
        </button>
      </nav>
    </main>
  );
}
