import { readFile } from "node:fs/promises";
import path from "node:path";

// 只允许读取两个技能入口，不暴露通用文件系统路径。
export const skillNames = ["we-article-writing", "we-article-revision"] as const;
export type SkillName = typeof skillNames[number];
export function readWritingSkill(name: SkillName) {
  return readFile(path.join(process.cwd(), ".agents", "skills", name, "SKILL.md"), "utf8");
}
