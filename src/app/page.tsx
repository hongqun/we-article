"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import WechatLayout from "./WechatLayout";
import ManualEditHistory from "./ManualEditHistory";
import AppNavigation from "./AppNavigation";
import { isWritingTopic } from "../lib/topic-policy";
import { mergeAutosavedProject } from "../lib/article-autosave";
import {
  newProject,
  toProjectSummary,
  canWriteArticle,
  hasCurrentDirection,
  hasConfirmedDirection,
  outlineBasis,
  invalidateDirection,
  articleVersionLabels,
  stageForViewing,
  stages,
  stageLabels,
  type Project,
  type ProjectSummary,
  type Stage,
  type WritingTopicSummary,
} from "../lib/project";

// MDXEditor 依赖浏览器编辑能力，只在客户端加载，避免 Next.js 服务端渲染报错。
const MaterialAnalysisEditor = dynamic(
  () => import("./MaterialAnalysisEditor"),
  {
    ssr: false,
    loading: () => (
      <div className="document-editor editor-loading">
        正在打开 Markdown 编辑器…
      </div>
    ),
  },
);

// 请求统一读取错误信息；业务操作仍直接写在页面中，便于顺着按钮阅读。
async function request<T>(url: string, value?: unknown): Promise<T> {
  const response = await fetch(
    url,
    value === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}

type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "saved" | "done"; project: Project }
  | { type: "error"; message: string };

type MaterialInputMode = "text" | "url" | "file";
type TopicPanel = "candidates" | "decision";

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const [project, setProjectState] = useState<Project | null>(null);
  // 事件回调与保存队列共享最新快照，避免闭包中的旧正文被再次发送。
  const projectRef = useRef<Project | null>(null);
  const editRevision = useRef(0);
  const bodyPending = useRef(false);
  const autoFlight = useRef<Promise<void> | null>(null);
  const [autoState, setAutoState] = useState<"idle" | "waiting" | "saving" | "saved" | "error">("idle");
  const setProject = useCallback((value: SetStateAction<Project | null>) => {
    const next = typeof value === "function" ? value(projectRef.current) : value;
    projectRef.current = next;
    setProjectState(next);
  }, []);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [writingTopics, setWritingTopics] = useState<WritingTopicSummary[]>([]);
  const [instruction, setInstruction] = useState("");
  const [materialInputMode, setMaterialInputMode] = useState<MaterialInputMode>("text");
  const [topicPanel, setTopicPanel] = useState<TopicPanel>("candidates");
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = useCallback((value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  }, []);
  const [wechatOpen, setWechatOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  // 本次思考流独立展示，不能写入正文编辑器；切换项目或阶段时清空。
  const [thinkingText, setThinkingText] = useState("");
  const [generating, setGenerating] = useState(false);
  const thinkingProcessRef = useRef<HTMLDetailsElement>(null);
  // 思考流持续追加时，把唯一的滚动容器保持在最新内容处。
  useEffect(() => {
    const container = thinkingProcessRef.current;
    if (!container || !generating) return;
    container.scrollTop = container.scrollHeight;
  }, [thinkingText, generating]);
  const [error, setError] = useState("");
  const [viewVersionId, setViewVersionId] = useState("");
  const [analysisFocusAtEndKey, setAnalysisFocusAtEndKey] = useState(0);
  const imagePromptDialog = useRef<HTMLDialogElement>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imagePromptLoading, setImagePromptLoading] = useState(false);
  const [imagePromptCopyState, setImagePromptCopyState] = useState("");
  // 窄屏只切换可见面板，两个面板仍保留以维持编辑、滚动和生成状态。
  const [mobileWorkspaceView, setMobileWorkspaceView] = useState<"document" | "conversation">("document");
  const newProjectDialog = useRef<HTMLDialogElement>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const [selectedNewTopic, setSelectedNewTopic] = useState("");
  const [leaveDestination, setLeaveDestination] = useState("");
  // 阶段导航使用统一名称；专题差异只保留在写作规则与内容要求中。
  const currentTopic = writingTopics.find((topic) => topic.id === project?.topicId);
  // 已保存列表只在本地轻量摘要中筛选，不影响当前编辑项目或服务端项目数据。
  const isManagedTopic = Boolean(project && isWritingTopic(project.topicId));
  const labels = { ...stageLabels, topics: "选题与方向", outline: "写作大纲" };

  useEffect(() => {
    setThinkingText("");
  }, [project?.id, project?.stage]);

  useEffect(() => {
    if (project?.stage === "topics")
      setTopicPanel(project.selectedTopic.trim() ? "decision" : "candidates");
  }, [project?.id, project?.stage]);

  useEffect(() => {
    // 打开仅含链接的旧项目时，直接展示它实际使用的材料来源。
    setMaterialInputMode(project?.url.trim() && !project.source.trim() ? "url" : "text");
  }, [project?.id]);

  useEffect(() => {
    request<ProjectSummary[]>("/api/projects")
      .then(setProjects)
      .catch((error: Error) => setError(error.message));
    request<WritingTopicSummary[]>("/api/topics")
      .then(setWritingTopics)
      .catch((error: Error) => setError(error.message));
  }, [setProject]);

  useEffect(() => {
    // 订阅客户端路由参数，避免文章管理跳转时先创建空项目再覆盖已打开项目。
    if (!projectId && writingTopics.length) {
      setProject(newProject((writingTopics.find(topic => topic.isDefault) ?? writingTopics[0]).id));
      return;
    }
    if (projectId) void open(projectId);
  // 保留 projectId，避免清理地址栏后再次触发空项目初始化；open 依赖当前编辑状态。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, writingTopics, setProject]);

  // 自动保存单请求串行；响应只更新版本元数据，不能盖掉请求期间的新编辑。
  const persistAutosave = useCallback((): Promise<void> => {
    if (autoFlight.current) return autoFlight.current;
    const snapshot = projectRef.current;
    if (!snapshot || !bodyPending.current || busyRef.current) return Promise.resolve();
    const revision = editRevision.current;
    setAutoState("saving");
    const flight = request<Project>("/api/projects", { ...snapshot, autosave: true }).then(saved => {
      if (projectRef.current?.id !== saved.id) return;
      const unchanged = editRevision.current === revision;
      setProject(current => current ? mergeAutosavedProject(current, saved, unchanged) : current);
      setProjects(items => [toProjectSummary(saved), ...items.filter(item => item.id !== saved.id)]);
      if (unchanged) {
        bodyPending.current = false;
        setDirty(false);
        setAutoState("saved");
      } else setAutoState("waiting");
    }).catch(() => {
      // 保留未保存标记；继续编辑或点击保存可重试，不把失败显示成成功。
      setAutoState("error");
    }).finally(() => { autoFlight.current = null; });
    autoFlight.current = flight;
    return flight;
  }, [setProject]);

  useEffect(() => {
    if (!bodyPending.current || busy || autoState === "error") return;
    const timer = setTimeout(() => { void persistAutosave(); }, 1500);
    return () => clearTimeout(timer);
  }, [project, busy, autoState, persistAutosave]);

  // 离开页面前提示未保存编辑；生成和显式保存均会把当前状态落盘。
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || busy) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);

  function edit(patch: Partial<Project>) {
    // 与服务端一致地撤销上游变更后的确认，同时保留旧成果。
    const current = projectRef.current;
    if (!current) return;
    editRevision.current++;
    if (patch.results && patch.results.article !== current.results.article) bodyPending.current = true;
    setProject(invalidateDirection({ ...current, ...patch }, current));
    if (bodyPending.current) setAutoState("waiting");
    setDirty(true);
    setStatus("");
  }
  function remember(saved: Project) {
    bodyPending.current = false;
    setAutoState("idle");
    setProject(saved);
    setDirty(false);
    setProjects((items) => [
      // 保存后与服务端列表共用命名规则，避免刷新前后名称不同。
      toProjectSummary(saved),
      ...items.filter((item) => item.id !== saved.id),
    ]);
  }
  async function save(next = project, successMessage = "已保存",
    flags: { confirmDirection?: boolean; confirmTopic?: boolean; confirmOutline?: boolean; restoreOutlineId?: string } = {}) {
    if (!next) return;
    setBusy(true);
    setError("");
    try {
      await autoFlight.current;
      const saved = await request<Project>("/api/projects", { ...next, ...flags });
      remember(saved);
      setStatus(successMessage);
      return saved;
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function copyArticleMarkdown() {
    // 直接读取当前编辑快照，复制尚未自动保存的最新 Markdown。
    const current = projectRef.current;
    if (!current || current.stage !== "article" || busyRef.current || !current.results.article.trim()) return;
    setError("");
    try {
      await navigator.clipboard.writeText(current.results.article);
      setStatus("已复制当前正文的 Markdown 文本");
    } catch {
      setError("复制失败，请检查浏览器的剪贴板权限后重试。");
    }
  }
  async function showImagePrompt() {
    // 直接发送当前编辑快照，让尚未自动保存的正文也能进入配图提示词。
    const current = projectRef.current;
    if (!current || current.stage !== "article" || !current.results.article.trim()) return;
    setError(""); setImagePromptCopyState(""); setImagePromptLoading(true);
    try {
      const result = await request<{ prompt: string }>("/api/image-prompts", {
        topicId: current.topicId, articleMarkdown: current.results.article,
      });
      setImagePrompt(result.prompt);
      imagePromptDialog.current?.showModal();
    } catch (error) {
      setError(error instanceof Error ? error.message : "配图提示词生成失败，请重试。");
    } finally { setImagePromptLoading(false); }
  }
  async function copyImagePrompt() {
    if (!imagePrompt.trim()) return;
    setImagePromptCopyState("");
    try {
      await navigator.clipboard.writeText(imagePrompt);
      setImagePromptCopyState("已复制配图提示词。");
    } catch {
      setImagePromptCopyState("复制失败，请检查浏览器的剪贴板权限后重试。");
    }
  }
  async function restoreVersion(id: string) {
    if (!project) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // 把未保存正文一并交给服务端，先留存再恢复，避免丢失用户修改。
      await autoFlight.current;
      remember(await request<Project>("/api/projects", { ...projectRef.current, restoreVersionId: id }));
      setViewVersionId("");
      setStatus("已恢复正文并保存为新版本");
    } catch (error) {
      setError(error instanceof Error ? error.message : "恢复失败");
    } finally {
      setBusy(false);
    }
  }
  async function finalize() {
    const current = projectRef.current;
    if (!current || busy || !current.results.article.trim()) return;
    setBusy(true);
    setError("");
    setStatus("正在保存成稿并检查正文结构…");
    try {
      await autoFlight.current;
      const latest = projectRef.current;
      if (!latest) return;
      const saved = await request<Project>("/api/projects/finalize", latest);
      remember(saved);
      const record = [...saved.finalizations].reverse().find(item => item.topicId === saved.topicId);
      setStatus(record?.structuralChange
        ? "已成稿；正文结构有明显变化，本篇大纲已同步修订。"
        : "已成稿；正文结构与大纲一致。");
    } catch (error) {
      // 成稿判断失败时正文已经安全落盘，重开当前项目同步保存后的版本状态。
      try { remember(await request<Project>(`/api/projects?id=${current.id}`)); } catch { /* 保留页面当前编辑。 */ }
      setError(error instanceof Error ? error.message : "成稿失败，请重试。");
      setStatus("");
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string, topicId?: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      // 切换文章前等待在途保存，并保存最后一笔正文；失败时留在当前文章。
      const hadBodyPending = bodyPending.current;
      await autoFlight.current;
      if (hadBodyPending && projectRef.current) {
        remember(await request<Project>("/api/projects", projectRef.current));
      } else if (dirty && !window.confirm("当前有未保存修改。要放弃修改并切换文章吗？")) return;
      const defaultTopic = writingTopics.find(topic => topic.isDefault) ?? writingTopics[0];
      const selectedTopicId = topicId ?? defaultTopic?.id;
      if (!id && !selectedTopicId) throw new Error("没有可用专题，请检查 topics 配置目录。");
      const loaded = id ? await request<Project>(`/api/projects?id=${id}`) : newProject(selectedTopicId!);
      // 回退只影响本次工作台视图；项目原始阶段仍由服务端保存的数据决定。
      remember(id ? { ...loaded, stage: stageForViewing(loaded) } : loaded);
      setInstruction("");
      setViewVersionId("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "打开失败");
    } finally {
      setBusy(false);
    }
  }
  function showNewProjectDialog() {
    setSelectedNewTopic((writingTopics.find(topic => topic.isDefault) ?? writingTopics[0])?.id ?? "");
    newProjectDialog.current?.showModal();
  }
  async function createProject() {
    if (!selectedNewTopic) return;
    newProjectDialog.current?.close();
    await open("", selectedNewTopic);
  }
  async function requestNavigation(href: string) {
    if (href === "/") return;
    await autoFlight.current;
    if (!dirty) { router.push(href); return; }
    setLeaveDestination(href);
    leaveDialog.current?.showModal();
  }
  async function saveAndLeave() {
    const saved = await save(projectRef.current, "已保存，正在打开菜单…");
    if (saved && leaveDestination) router.push(leaveDestination);
  }
  function discardAndLeave() { if (leaveDestination) router.push(leaveDestination); }
  async function generate(text: string, inputProject = project, inputDirty = dirty,
    operation: "stage" | "direction" = inputProject && isWritingTopic(inputProject.topicId) && inputProject.stage === "topics" && inputProject.selectedTopic.trim() ? "direction" : "stage",
    instructionSource: "user" | "button" = "button", regenerateFromOutline = false, regenerateCandidates = false,
    regenerateOutline = false) {
    if (!inputProject || !text.trim()) return;
    // 同一文章使用事件发生时的最新状态；阶段推进传入的已保存项目仍保持其阶段。
    const latestProject = projectRef.current;
    if (latestProject && latestProject.id === inputProject.id) inputProject = latestProject;
    const activeTopicId = inputProject.topicId;
    if (!writingTopics.some((topic) => topic.id === activeTopicId)) {
      setError("当前专题不可用，请检查专题配置并刷新页面。");
      return;
    }
    if ((inputProject.stage === "outline" || inputProject.stage === "article") && !hasConfirmedDirection(inputProject)) {
      setError("请回到第二步，根据当前标题调整并确认核心方向。");
      return;
    }
    if (inputProject.stage === "article" && !canWriteArticle(inputProject)) {
      setError(`请先完成并确认${labels.outline}，再生成或改写正文。`);
      return;
    }
    const targetStage = inputProject.stage;
    // 流式结果只是预览；失败时还原调用前正文及已保存的版本状态。
    let fallbackProject = inputProject;
    let fallbackDirty = inputDirty;
    let completed = false;
    setViewVersionId("");
    setBusy(true);
    setError("");
    setStatus("正在整理，请稍候…");
    setThinkingText("");
    setGenerating(true);
    let streamedResult = "";
    let streamFlushTimer: ReturnType<typeof setTimeout> | undefined;
    // 限制编辑器重解析频率，避免每个 token 都重建 Lexical 内容和滚动位置。
    const flushStreamedResult = () => {
      streamFlushTimer = undefined;
      setProject((current) =>
        current
          ? {
              ...current,
              // 方向流式结果写入独立区域，候选成果始终保留。
              ...(operation === "direction" ? { coreDirection: streamedResult } : { results: {
                ...current.results,
                [targetStage]: streamedResult,
              } }),
            }
          : current,
      );
    };
    const scheduleStreamedResult = () => {
      if (streamFlushTimer === undefined)
        streamFlushTimer = setTimeout(flushStreamedResult, 80);
    };
    try {
      // 模型请求排在自动保存之后；显式保存成功才允许调用，失败不会退回旧稿。
      await autoFlight.current;
      const latest = projectRef.current?.id === inputProject.id ? projectRef.current : inputProject;
      inputProject = await request<Project>("/api/projects", latest);
      fallbackProject = inputProject;
      fallbackDirty = false;
      remember(inputProject);
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: inputProject, instruction: text, operation, instructionSource, regenerateFromOutline, regenerateCandidates, regenerateOutline }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "生成失败，请重试");
      }
      if (!response.body) throw new Error("生成服务没有返回流。");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentStreamEvent;
          if (event.type === "reasoning") {
            setThinkingText((current) => current + event.text);
            setStatus("正在思考…");
          } else if (event.type === "token") {
            streamedResult += event.text;
            scheduleStreamedResult();
            setStatus("正在生成…");
          } else if (event.type === "status") {
            setStatus(event.message);
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else if (event.type === "saved") {
            fallbackProject = event.project;
            fallbackDirty = false;
            remember(event.project);
          } else if (event.type === "done") {
            completed = true;
            setGenerating(false);
            if (streamFlushTimer !== undefined) {
              clearTimeout(streamFlushTimer);
              flushStreamedResult();
            }
            remember(event.project);
            setAnalysisFocusAtEndKey((key) => key + 1);
          }
        }
        // 保存完成事件已经确认结果，不再等待连接关闭来判定成功。
        if (done || completed) break;
      }
      if (!completed) throw new Error("生成连接中断，未收到保存成功结果，请重试或重新打开项目。");
      setInstruction("");
      setStatus("成果已更新并保存");
    } catch (error) {
      if (streamFlushTimer !== undefined) {
        clearTimeout(streamFlushTimer);
        streamFlushTimer = undefined;
      }
      if (!completed) {
        setProject(fallbackProject);
        setDirty(fallbackDirty);
      }
      setError(error instanceof Error ? error.message : "生成失败");
      setStatus("");
    } finally {
      setGenerating(false);
      if (streamFlushTimer !== undefined) clearTimeout(streamFlushTimer);
      setBusy(false);
    }
  }
  async function confirmStage() {
    if (!project || busy) return;
    if (project.stage === "article") { await finalize(); return; }
    if (!(project.stage === "topics" && isManagedTopic) && !project.results[project.stage].trim()) return;
    if (project.stage === "topics" && isManagedTopic &&
      (!hasCurrentDirection(project) || !project.results.analysis.trim())) return;
    if (project.stage === "outline" && !project.selectedTopic.trim()) return;
    if (project.stage === "outline" && !hasConfirmedDirection(project)) return;
    const nextStage = stages[stages.indexOf(project.stage) + 1];
    // 每步显式确认，再进入下一步；旧成果可查看但不会被自动覆盖。
    const saved = await save({
      ...project,
      stage: nextStage ?? project.stage,
      outlineConfirmed: project.stage === "outline" ? true : project.outlineConfirmed,
    }, nextStage
      ? `已保存并进入${labels[nextStage]}，已有成果会保留；需要更新时请点击“重新生成”。`
      : "正文与版本已保存", project.stage === "topics" && isManagedTopic
      ? { confirmTopic: true, confirmDirection: true }
      : project.stage === "outline" ? { confirmOutline: true } : {});
    if (!saved || !nextStage) return;
    // 只为尚无成果的下一阶段调用模型；失败时回到已保存的下一阶段，允许重试。
    if (!saved.results[nextStage].trim() || (nextStage === "article" && saved.articleNeedsRegeneration)) {
      await generate(`请生成完整的${labels[nextStage]}。`, saved, false, "stage", "button",
        nextStage === "article" && saved.articleNeedsRegeneration);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    if (!/\.(md|txt)$/i.test(file.name)) {
      setError("请选择 Markdown 或 TXT 文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const source = await file.text();
      if (source.length > 100000)
        throw new Error("材料超过 10 万字符，请选取需要解读的部分。");
      edit({
        source,
        title: file.name.replace(/\.(md|txt)$/i, "").slice(0, 120),
        outlineConfirmed: false,
      });
      // 文件内容写入原有正文材料字段后，切回文本页方便用户检查和继续编辑。
      setMaterialInputMode("text");
    } catch (error) {
      setError(error instanceof Error ? error.message : "文件读取失败");
    } finally {
      setBusy(false);
    }
  }
  function canVisit(stage: Stage) {
    if (!project) return false;
    // 上游待复核时仍允许查看已有正文和历史，模型调用另行检查确认状态。
    if (stage === "article") return canWriteArticle(project) || Boolean(project.results.article || project.articleVersions.length);
    return (
      stage === "analysis" ||
      (Boolean(project.results.analysis.trim()) &&
        (stage === "topics" || Boolean(project.selectedTopic.trim())))
    );
  }

  if (!project) return <main className="loading">正在打开文章工作台…</main>;
  const hasMaterial = Boolean(project.source.trim() || project.url.trim());
  const result = project.results[project.stage];
  const isTopicDirection = isManagedTopic && project.stage === "topics";
  // 字数仅作短文方向提示，不截断模型输出或用户手动输入。
  const directionLength = Array.from(project.coreDirection.replace(/\s/g, "")).length;
  const canGenerate = Boolean(currentTopic) && hasMaterial &&
    (!project.topicReviewPending || project.stage === "analysis" || project.stage === "topics") &&
    (!(project.stage === "outline" || project.stage === "article") || hasConfirmedDirection(project)) &&
    (project.stage !== "article" || canWriteArticle(project));
  const viewedVersion = project.articleVersions.find((version) => version.id === viewVersionId);
  const currentFinalization = [...project.finalizations].reverse().find(item => item.topicId === project.topicId);
  const nextStage = stages[stages.indexOf(project.stage) + 1];
  const finalizedCurrentVersion = project.finalizations.some(item => item.status === "completed" &&
    item.topicId === project.topicId && item.articleVersionId === project.articleVersions.at(-1)?.id);
  const canViewImagePrompt = Boolean(currentTopic?.imagePrompt && project.stage === "article" && result.trim());
  const canConfirm = isTopicDirection ? Boolean(hasCurrentDirection(project) && project.results.analysis.trim()) : Boolean(result.trim()) &&
    (!project.topicReviewPending || project.stage === "analysis") &&
    (project.stage !== "outline" || hasConfirmedDirection(project)) &&
    (project.stage !== "article" || canWriteArticle(project) || finalizedCurrentVersion) &&
    (!(project.stage === "topics" || project.stage === "outline") || Boolean(project.selectedTopic.trim()));
  // 候选区和其他阶段沿用同一编辑器，统一保存语义与流式更新。
  const stageEditor = (
    <MaterialAnalysisEditor
      key={`${project.id}:${project.stage}`}
      markdown={result}
      disabled={busy}
      focusAtEndKey={project.stage === "analysis" ? analysisFocusAtEndKey : 0}
      onChange={(markdown) => {
        const current = projectRef.current;
        if (busyRef.current || !current || markdown === current.results[project.stage]) return;
        edit({
          results: { ...current.results, [project.stage]: markdown },
          outlineConfirmed: project.stage === "article" ? current.outlineConfirmed : false,
        });
      }}
    />
  );
  return (
    <main className="workspace-page">
      <header className="topbar">
        <div className="brand">
          <Image className="brand-mark" src="/logo-mark.svg" alt="" width={46} height={46} priority />
          <div>
            <h1>We-Article</h1>
            <p>读懂材料，找到值得写的角度。</p>
          </div>
        </div>
        <div className="project-actions">
          <AppNavigation onNavigate={(href) => void requestNavigation(href)} />
          <button disabled={busy || !writingTopics.length} onClick={showNewProjectDialog}>新建文章</button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void save()}
          >
            保存项目
          </button>
        </div>
      </header>

      {/* 标题、专题和状态收敛为一条上下文栏，避免在阶段导航前重复占用纵向空间。 */}
      <section className="project-context" aria-label="当前文章信息">
        <input
          className="title-input"
          aria-label="文章名称"
          maxLength={120}
          value={project.title}
          disabled={busy}
          onChange={(event) => edit({ title: event.target.value })}
        />
        <label className="context-topic">
          <span>专题</span>
          <select
            value={project.topicId}
            disabled={busy || writingTopics.length === 0}
            onChange={(event) => {
              if (event.target.value === project.topicId) return;
              // 切换时一并保存当前编辑，成功后才更新页面；成果和正文历史均保留。
              void save(
                { ...project, topicId: event.target.value, outlineConfirmed: false },
                "专题已切换并保存，请按新专题复核选题与思路。",
              );
            }}
          >
            {!currentTopic && <option value={project.topicId}>{writingTopics.length ? `不可用专题：${project.topicId}` : "正在读取专题…"}</option>}
            {writingTopics.map((topic) => <option key={topic.id} value={topic.id}>{topic.name}</option>)}
          </select>
        </label>
        <p className="context-description">{currentTopic?.description ?? "请检查专题配置；已有成果仍可查看。"}</p>
        {(autoState !== "idle" || dirty || status) && <span className="save-state" role="status">
          {autoState === "error" ? "自动保存失败" : autoState === "saving" ? "保存中…" :
            autoState === "waiting" ? "等待保存…" : status || (autoState === "saved" ? "已自动保存" : "有未保存修改")}
        </span>}
      </section>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {/* 阶段条与双栏工作区共享一个固定壳，避免多个 sticky 容器相互覆盖。 */}
      <section className="workspace-shell" aria-label="写作工作区">
      <nav className="steps" aria-label="写作阶段">
        {stages.map((stage, index) => (
          <button
            key={stage}
            className={project.stage === stage ? "active" : ""}
            aria-current={project.stage === stage ? "step" : undefined}
            disabled={busy || !canVisit(stage)}
            onClick={() => edit({ stage })}
          >
            <span>0{index + 1}</span>
            {labels[stage]}
          </button>
        ))}
      </nav>

      <div className={`workspace mobile-${mobileWorkspaceView}`} aria-busy={busy}>
        {/* 成果是桌面端主画布；反馈轨道通过样式排在右侧，小屏幕也优先阅读成果。 */}
        <section className="conversation feedback-rail" aria-label="材料与对话">
          {/* 材料、消息与思考共享滚动区，输入区独立留在底部。 */}
          <div className="conversation-scroll">
          <details
            className="material"
            open={!hasMaterial || !project.results.analysis}
          >
            <summary>
              原始材料{" "}
              <span>
                {project.source.length
                  ? `${project.source.length.toLocaleString()} 字符`
                  : "文本、文件或网页"}
              </span>
            </summary>
            <div className="material-input-tabs" role="tablist" aria-label="材料输入方式">
              {(["text", "url", "file"] as const).map((mode) => (
                <button key={mode} type="button" role="tab"
                  id={`material-tab-${mode}`} aria-controls={`material-panel-${mode}`}
                  aria-selected={materialInputMode === mode} tabIndex={materialInputMode === mode ? 0 : -1}
                  onClick={() => setMaterialInputMode(mode)}>
                  {{ text: "粘贴文本", url: "网页链接", file: "导入文件" }[mode]}
                </button>
              ))}
            </div>
            {materialInputMode === "text" && <div id="material-panel-text" role="tabpanel" aria-labelledby="material-tab-text">
              <label>
                材料或话题
                <textarea rows={7} maxLength={100000} disabled={busy}
                  placeholder="粘贴原文，或写下想讨论的话题…" value={project.source}
                  onChange={(event) => edit({ source: event.target.value, outlineConfirmed: false })} />
              </label>
            </div>}
            {materialInputMode === "url" && <div id="material-panel-url" role="tabpanel" aria-labelledby="material-tab-url">
              <label>
                网页链接
                <input type="url" disabled={busy} placeholder="https://…" value={project.url}
                  onChange={(event) => edit({ url: event.target.value, outlineConfirmed: false })} />
              </label>
              <p className="hint">有正文时优先使用正文。更换网页后，请清空旧正文再解读。</p>
            </div>}
            {materialInputMode === "file" && <div id="material-panel-file" role="tabpanel" aria-labelledby="material-tab-file">
              <label className="file-label">
                选择 Markdown 或文本文件
                <input type="file" accept=".md,.txt,text/plain,text/markdown" disabled={busy}
                  onChange={(event) => {
                    void importFile(event.target.files?.[0]);
                    event.target.value = "";
                  }} />
              </label>
            </div>}
          </details>
          <div className="discussion-heading">
            <h2>一起推敲</h2>
            <span>{labels[project.stage]}</span>
          </div>
          <div className="messages">
            {project.messages.length === 0 && (
              <div className="empty-chat">
                <h3>先读懂，再动笔。</h3>
                <p>
                  添加材料后，点击“生成材料解读”。你可以继续追问，或直接提出修改方向。
                </p>
              </div>
            )}
            {project.messages.map((message, index) => (
              <article className={`message ${message.role}`} key={index}>
                <div className="message-label">
                  {message.role === "user" ? "你" : "写作助手"} ·{" "}
                  {labels[message.stage]}
                </div>
                {message.role === "assistant" ? (
                  <details>
                    <summary>查看这次成果</summary>
                    <p>{message.content}</p>
                  </details>
                ) : (
                  <p>{message.content}</p>
                )}
              </article>
            ))}
            {busy && (
              <p className="hint" role="status">
                {status || "正在处理当前操作…"}
              </p>
            )}
          </div>
          {/* 思考随讨论内容滚动，避免叠加第二个受限滚动框。 */}
          {(thinkingText || generating) && (
            <details ref={thinkingProcessRef} className="thinking-process" open>
              <summary>{generating ? "思考过程 · 生成中" : "本次思考过程"}</summary>
              <div className="thinking-content">
                {thinkingText || "等待模型返回思考内容…"}
              </div>
            </details>
          )}
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              // 只有用户输入框的内容作为直接反馈，按钮默认指令不参加风格学习。
              void generate(instruction, project, dirty, undefined, "user");
            }}
          >
            {isTopicDirection && (
              <p className="hint">{project.selectedTopic.trim()
                ? "当前讨论：围绕选定标题精简核心方向。标题可在右侧直接修改。"
                : "当前讨论：探索候选标题与写作方向。"}</p>
            )}
            <textarea
              aria-label="修改意见"
              rows={3}
              disabled={busy}
              value={instruction}
              placeholder={isTopicDirection ? "例如：让方向更聚焦，明确读者能解决什么问题。" : "例如：从普通用户的角度重新分析，减少术语。"}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <button
              className="primary"
              disabled={busy || !canGenerate || !instruction.trim()}
            >
              发送修改意见
            </button>
          </form>
        </section>

        <section className="document document-canvas" aria-label="当前阶段成果">
          <div className="document-heading">
            <div>
              <h2>{labels[project.stage]}</h2>
              <p>{isTopicDirection ? "确定一个标题，再聚焦这篇文章的核心方向。" : "可直接编辑，下次讨论会参考你的修改。"}</p>
            </div>
            <div className="document-heading-actions">
              {project.stage === "article" && <button
                type="button"
                disabled={busy || !result.trim()}
                onClick={() => void copyArticleMarkdown()}
              >
                复制 Markdown
              </button>}
              {!isTopicDirection && <button
                disabled={busy || !canGenerate}
                onClick={() =>
                  void generate(
                    `请${result ? "重新整理" : "生成"}完整的${labels[project.stage]}。`,
                    project, dirty, "stage", "button", project.stage === "article" && Boolean(result), false,
                    project.stage === "outline" && Boolean(result),
                  )
                }
              >
                {project.stage === "article" && result ? "按当前大纲重写正文" : result ? "重新生成" : `生成${labels[project.stage]}`}
              </button>}
            </div>
          </div>
          {/* 成果头尾不参与滚动，正文及历史记录共用中间滚动区。 */}
          <div className="document-scroll">
          {isTopicDirection ? (
            <div className="topic-direction-workspace">
              {/* 候选探索与本篇确认通过 Tab 分开，避免输入区同时堆叠。 */}
              <div className="topic-tabs" role="tablist" aria-label="选题与方向">
                <button type="button" role="tab" id="topic-tab-candidates" aria-controls="topic-panel-candidates"
                  aria-selected={topicPanel === "candidates"} tabIndex={topicPanel === "candidates" ? 0 : -1}
                  onClick={() => setTopicPanel("candidates")}>候选标题与初步方向</button>
                <button type="button" role="tab" id="topic-tab-decision" aria-controls="topic-panel-decision"
                  aria-selected={topicPanel === "decision"} tabIndex={topicPanel === "decision" ? 0 : -1}
                  onClick={() => setTopicPanel("decision")}>本篇选题与核心方向</button>
              </div>
              {topicPanel === "candidates" && <section className="topic-tab-panel topic-candidates" id="topic-panel-candidates"
                role="tabpanel" aria-labelledby="topic-tab-candidates">
                <div className="candidate-actions">
                  <p className="hint">候选内容用于探索角度；确定标题和方向请切换到“本篇选题与核心方向”。</p>
                  <button type="button" className="topic-action topic-action-muted" disabled={busy || !canGenerate}
                    onClick={() => void generate("请重新生成简短的初步方向和候选标题。", project, dirty, "stage", "button", false, true)}>
                    {result ? "重新生成候选" : "生成候选"}
                  </button>
                </div>
                {stageEditor}
              </section>}
              {topicPanel === "decision" && <section className="topic-tab-panel topic-decision" id="topic-panel-decision"
                role="tabpanel" aria-labelledby="topic-tab-decision">
              <div className="topic-decision-heading">
                <div>
                  <h3>本篇选题</h3>
                  <p className="hint">从候选中确定标题，也可以直接输入自己的标题。</p>
                </div>
                <button type="button" className="topic-action topic-action-secondary" disabled={busy || !hasMaterial || !currentTopic || !project.selectedTopic.trim() || !project.results.analysis.trim()}
                  onClick={() => void generate("请根据选定标题整理当前专题的核心方向，保持简洁，不提前展开大纲或正文。", project, dirty, "direction")}>
                  根据标题整理方向
                </button>
              </div>
              <label>
                选定标题
                <input disabled={busy} value={project.selectedTopic}
                  placeholder="填写选中的标题，或输入自己的标题"
                  onChange={(event) => edit({ selectedTopic: event.target.value, outlineConfirmed: false })} />
              </label>
              <div className="topic-direction-editor">
              <div className="direction-heading">
                <span>{currentTopic?.directionLabel ?? "说明本篇要回答的问题或表达的判断"}</span>
              </div>
              <label>
                核心方向
                <textarea rows={5} disabled={busy} value={project.coreDirection}
                  aria-describedby="direction-length"
                  placeholder={`说明这篇文章要回答什么问题或表达什么判断；建议${currentTopic?.directionLength?.min ?? 40}—${currentTopic?.directionLength?.max ?? 80}字。`}
                  onChange={(event) => edit({ coreDirection: event.target.value, directionTopic: project.selectedTopic })} />
              </label>
              <p id="direction-length" className={`hint${directionLength > (currentTopic?.directionLength?.max ?? 80) ? " direction-length-warning" : ""}`}>
                {directionLength} 字 · 建议{currentTopic?.directionLength?.min ?? 40}—{currentTopic?.directionLength?.max ?? 80}字（不计空白）
              </p>
              <p className="hint">请检查方向是否对应当前标题；确认后进入{labels.outline}。</p>
              </div>
              </section>
              }
            </div>
          ) : stageEditor}
          {project.stage === "outline" && project.results.outline.trim() &&
            project.outlineBasis !== outlineBasis(project) && <p className="hint">
              题目或方向已变化，请修改或重新生成{labels.outline}后再确认。
            </p>}
          {isManagedTopic && project.stage === "article" && (
            <details className="article-outline-reference">
              <summary>查看写作方向与{labels.outline}</summary>
              <div>
                <p>{project.coreDirection}</p>
                <MaterialAnalysisEditor markdown={project.results.outline} disabled focusAtEndKey={0} onChange={() => {}} />
                <button disabled={busy} onClick={() => edit({ stage: "outline" })}>调整{labels.outline}</button>
              </div>
            </details>
          )}
          {project.stage === "article" && (
            <details className="article-versions" aria-label="文章版本">
              <summary>版本与手工记录 · {project.articleVersions.length} 个版本</summary>
              <div className="article-versions-content">
              {currentFinalization?.status === "completed" && <p className="hint">
                最近成稿：{currentFinalization.structuralChange
                  ? project.results.outline === currentFinalization.originalOutline
                    ? `曾检测到结构变化；当前已恢复成稿前的${labels.outline}。`
                    : `已按正文结构修订本篇${labels.outline}；修订前内容保存在成稿记录中。`
                  : `沿用已确认的${labels.outline}。`}
              </p>}
              {currentFinalization?.status === "completed" && <p className="hint">
                判断依据：{currentFinalization.reason}
              </p>}
              {currentFinalization?.status === "failed" && <p className="hint">
                正文已保存，结构检查未完成；可再次点击“成稿”。
              </p>}
              {currentFinalization?.structuralChange && <details>
                <summary>查看成稿前的{labels.outline}</summary>
                <pre>{currentFinalization.originalOutline}</pre>
                {project.results.outline !== currentFinalization.originalOutline && <button disabled={busy}
                  onClick={() => void save(project, `已恢复成稿前的${labels.outline}；下次生成正文前请重新确认。`,
                    { restoreOutlineId: currentFinalization.id })}>
                  恢复成稿前大纲
                </button>}
              </details>}
              {/* 历史仅作只读查看；恢复会新增版本，不把历史内容直接写入编辑器。 */}
              <label>
                查看文章版本（共 {project.articleVersions.length} 个）
                <select value={viewVersionId} disabled={busy} onChange={(event) => setViewVersionId(event.target.value)}>
                  <option value="">选择历史版本</option>
                  {[...project.articleVersions].reverse().map((version, index) => (
                    <option key={version.id} value={version.id}>
                      v{project.articleVersions.length - index} · {articleVersionLabels[version.source]} · {new Date(version.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              {viewedVersion && (
                <div className="version-preview">
                  <p>{viewedVersion.summary}</p>
                  <MaterialAnalysisEditor key={viewedVersion.id} markdown={viewedVersion.content} disabled focusAtEndKey={0} onChange={() => {}} />
                  <button disabled={busy} onClick={() => void restoreVersion(viewedVersion.id)}>恢复此版本</button>
                </div>
              )}
              {currentTopic?.styleMemory && <ManualEditHistory topicId={project.topicId} projectId={project.id} busy={busy}
                saveBeforeInspect={async () => {
                  // 打开记录前先落盘，确保当前编辑不会漏出本次连续手工编辑。
                  await autoFlight.current;
                  const saved = await request<Project>("/api/projects", projectRef.current);
                  remember(saved);
                }} />}
              </div>
            </details>
          )}
          </div>
          <footer className="document-footer">
            {isTopicDirection ? (
              <p>确认标题与方向后进入{labels.outline}。</p>
            ) : project.stage === "topics" ? (
              <label>
                确认的选题
                <input
                  disabled={busy}
                  value={project.selectedTopic}
                  placeholder="填写选中的标题或角度"
                  onChange={(event) => edit({
                    selectedTopic: event.target.value,
                    outlineConfirmed: false,
                  })}
                />
              </label>
            ) : (
              <p>
                {project.stage === "analysis"
                  ? "确认解读后进入选题；没有选题成果时自动生成。"
                  : project.stage === "article" && !canWriteArticle(project)
                    ? `上游内容或专题已修改，请重新确认${labels.outline}后继续生成或改写。`
                    : `当前选题：${project.selectedTopic}`}
              </p>
            )}
            {/* 两套专题的确认入口一致；后续正文必须基于已确认的大纲。 */}
            <div className="document-final-actions">
              {project.stage === "article" && currentTopic?.publish?.enabled && <button disabled={busy || !project.results.article.trim()} onClick={() => setWechatOpen(true)}>公众号排版</button>}
              {canViewImagePrompt && <button disabled={busy || imagePromptLoading} onClick={() => void showImagePrompt()}>
                {imagePromptLoading ? "正在组装配图提示词…" : "查看配图提示词"}
              </button>}
              <button
                className={isTopicDirection ? "primary topic-action topic-action-confirm" : "primary"}
                disabled={busy || !canConfirm || !currentTopic}
                onClick={() => void confirmStage()}
              >
                {isTopicDirection ? `确认标题与方向，进入${labels.outline}` :
                  nextStage ? `确认并进入${labels[nextStage]}` : "成稿"}
              </button>
            </div>
          </footer>
        </section>
      </div>
      <nav className="mobile-workspace-tabs" aria-label="手机工作区视图">
        <button type="button" className={mobileWorkspaceView === "document" ? "active" : ""} aria-pressed={mobileWorkspaceView === "document"} onClick={() => setMobileWorkspaceView("document")}>阶段成果</button>
        <button type="button" className={mobileWorkspaceView === "conversation" ? "active" : ""} aria-pressed={mobileWorkspaceView === "conversation"} onClick={() => setMobileWorkspaceView("conversation")}>材料与对话</button>
      </nav>
      </section>
      {wechatOpen && project.stage === "article" && currentTopic?.publish?.enabled && <WechatLayout key={project.id + project.topicId}
        project={project} onClose={() => setWechatOpen(false)} saveBeforePush={async (markdown, topicId) => {
          // 等待自动保存后再次读取当前正文，不能推送已过时的预览。
          await autoFlight.current;
          const current = projectRef.current;
          if (!current || current.topicId !== topicId || current.results.article !== markdown) throw new Error("正文已变化，请刷新预览。");
          const saved = await save(current, "正文已保存，正在推送公众号草稿…");
          if (!saved) throw new Error("正文保存失败，未推送公众号。");
        }} />}
      <dialog ref={imagePromptDialog} className="image-prompt-dialog" onClose={() => setImagePromptCopyState("")} aria-labelledby="image-prompt-title">
        <header><div><p className="image-prompt-eyebrow">{currentTopic?.name} · 配图工作单</p><h2 id="image-prompt-title">配图提示词</h2></div>
          <button type="button" onClick={() => imagePromptDialog.current?.close()} aria-label="关闭配图提示词">关闭</button></header>
        <p>已按当前正文组装；它不会保存到项目中。复制后可直接交给图片生成模型。</p>
        <pre aria-label="组装后的配图提示词">{imagePrompt}</pre>
        <footer><p role="status" className={imagePromptCopyState.includes("失败") ? "image-prompt-error" : ""}>{imagePromptCopyState}</p>
          <button type="button" className="primary" onClick={() => void copyImagePrompt()}>复制配图提示词</button></footer>
      </dialog>
      <dialog ref={newProjectDialog} className="confirm-dialog" aria-labelledby="new-project-title">
        <h2 id="new-project-title">选择写作专题</h2>
        <p>新文章会从材料解读阶段开始，并采用所选专题的规则与提示词。</p>
        <div className="topic-choice-list" role="radiogroup" aria-label="写作专题">
          {writingTopics.map(topic => <label key={topic.id} className={selectedNewTopic === topic.id ? "selected" : ""}>
            <input type="radio" name="new-project-topic" value={topic.id} checked={selectedNewTopic === topic.id}
              onChange={() => setSelectedNewTopic(topic.id)} />
            <span><b>{topic.name}</b><small>{topic.description}</small></span>
          </label>)}
        </div>
        <footer><button type="button" onClick={() => newProjectDialog.current?.close()}>取消</button>
          <button type="button" className="primary" disabled={!selectedNewTopic || busy} onClick={() => void createProject()}>按此专题新建</button></footer>
      </dialog>
      <dialog ref={leaveDialog} className="confirm-dialog" onClose={() => setLeaveDestination("")} aria-labelledby="leave-workspace-title">
        <h2 id="leave-workspace-title">保存当前修改？</h2>
        <p>离开写作工作台前，可先保存当前项目；也可以放弃尚未保存的修改。</p>
        <footer><button type="button" disabled={busy} onClick={() => leaveDialog.current?.close()}>留在当前页</button>
          <button type="button" disabled={busy} onClick={() => { leaveDialog.current?.close(); discardAndLeave(); }}>放弃修改</button>
          <button type="button" className="primary" disabled={busy} onClick={() => void saveAndLeave()}>保存后离开</button></footer>
      </dialog>
    </main>
  );
}
