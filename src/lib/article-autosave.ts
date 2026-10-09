import type { ArticleVersion, Project } from "./project";

// 连续编辑每 30 秒最多追加一次自动快照；当前草稿始终逐次保存，历史版本不覆盖。
export function shouldAppendManualVersion(latest: ArticleVersion | undefined, content: string,
  autosave = false, now = Date.now()): boolean {
  if (latest ? latest.content === content : !content.trim()) return false;
  return !autosave || !latest?.autosaved || latest.source !== "manual" ||
    now - Date.parse(latest.createdAt) >= 30000;
}

// 保存期间用户继续输入时，只合并服务端元数据，不用旧响应覆盖新正文及其他编辑。
export function mergeAutosavedProject(current: Project, saved: Project, unchanged: boolean): Project {
  if (current.id !== saved.id) return current;
  return unchanged ? { ...saved, stage: current.stage } : {
    ...current, articleVersions: saved.articleVersions, updatedAt: saved.updatedAt,
  };
}
