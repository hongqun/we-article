import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { tool } from "langchain";

const skillMetadata = z.object({
  name: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().min(1).max(1024),
});

// 同时检查逻辑路径和真实路径，避免 ../ 或符号链接读到密钥与项目资料。
async function localFile(root: string, relative: string) {
  const inside = (base: string, target: string) => {
    const rel = path.relative(base, target);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const target = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !inside(root, target))
    throw new Error("技能文件路径必须位于本地技能目录内。");
  const resolved = await realpath(target);
  if (!inside(root, resolved)) throw new Error("技能文件不能通过符号链接越过技能目录。");
  return resolved;
}

// 发现阶段只返回名称、描述和入口；正文流程通过同一工具预读入口，模型按需读取参考。
// https://agentskills.io/specification
export async function createSkillAccess(
  enabledNames: string[],
  directory = path.join(process.cwd(), ".agents", "skills"),
) {
  const root = await realpath(directory);
  const entries = await readdir(root, { withFileTypes: true });
  const catalog = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && enabledNames.includes(entry.name))
    .map(async (entry) => {
      const location = `${entry.name}/SKILL.md`;
      const text = await readFile(await localFile(root, location), "utf8");
      const frontmatter = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!frontmatter) throw new Error(`技能 ${entry.name} 缺少 YAML 元数据。`);
      const metadata = skillMetadata.parse(parse(frontmatter[1]));
      if (metadata.name !== entry.name) throw new Error(`技能名称与目录不一致：${entry.name}`);
      return { ...metadata, location };
    }));
  for (const name of enabledNames) {
    if (!catalog.some((entry) => entry.name === name))
      throw new Error(`本地技能 ${name} 未安装，请检查 article/.agents/skills。`);
  }
  const loadedEntries = new Set<string>();
  const readSkillFile = tool(async ({ file }) => {
    // 工具接受目录内的相对路径；只开放当前阶段启用的技能。
    const normalized = path.normalize(file);
    const name = normalized.split(path.sep)[0];
    if (!catalog.some((entry) => entry.name === name))
      throw new Error("该技能未在当前阶段启用。");
    const content = await readFile(await localFile(root, file), "utf8");
    if (!content.trim()) throw new Error(`技能文件为空：${file}`);
    if (normalized === path.join(name, "SKILL.md")) loadedEntries.add(name);
    return { file: normalized, content };
  }, {
    name: "read_skill_file",
    description: "读取本地技能文件。先读取目录中列出的 SKILL.md，再按其说明读取 references 等附属文件。路径相对于技能根目录，例如 human-writing/SKILL.md；此工具不联网、不执行脚本。",
    schema: z.object({ file: z.string().min(1).describe("相对于本地技能根目录的文件路径") }),
  });
  return {
    catalog,
    tool: readSkillFile,
    // 文件存在不代表本次已加载；预读后和保存前均要求同一请求有真实入口读取记录。
    assertActivated() {
      for (const name of enabledNames) {
        if (!loadedEntries.has(name)) throw new Error(`本次未成功读取 ${name}/SKILL.md，本次正文未保存，请重试。`);
      }
    },
  };
}
