import type { Project } from "../project";
import type { MemoryEvent } from "./types";

// 清理待办必须晚于数据库提交；任一步失败都返回原待办，便于下次幂等重试。
export async function transferOutbox(project: Project, dependencies: {
  ingest: (events: MemoryEvent[]) => void | Promise<void>;
  persist: (project: Project) => Promise<void>;
}): Promise<Project> {
  if (!project.memoryOutbox.length) return project;
  try {
    await dependencies.ingest(project.memoryOutbox);
    const clean = { ...project, memoryOutbox: [] };
    await dependencies.persist(clean);
    return clean;
  } catch {
    return project;
  }
}
