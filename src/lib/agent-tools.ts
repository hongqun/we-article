import { load } from "cheerio";
import { tool } from "langchain";
import { z } from "zod";
import type { Project, Stage } from "./project";
import { hasCapability, type PromptOperation } from "./prompt-builder";
import { createArticleReferenceAccess } from "./article-reference";
import type { createSkillAccess } from "./skills";
import { formatXiachufangRecipe, readXiachufangRecipe, searchXiachufang } from "./xiachufang";

type SkillAccess = Awaited<ReturnType<typeof createSkillAccess>>;

type ToolFactoryOptions = {
  project: Project;
  stage: Stage;
  operation: PromptOperation;
  instruction?: string;
  skills?: Pick<SkillAccess, "tool">;
  onStatus?: (message: string) => void;
};

export function createReadSourceTool(project: Project) {
  return tool(
    async () => {
      const url = new URL(project.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 HTTP/HTTPS 网页。");
      // 单篇下厨房菜谱只传食材与步骤，避免相关推荐被误识别为本期内容。
      if (url.hostname === "www.xiachufang.com") {
        if (url.protocol !== "https:" || !/^\/recipe\/\d+\/?$/.test(url.pathname))
          throw new Error("下厨房搜索页或合集不能作为单期菜谱，请提供具体菜谱链接或菜品名称。");
        const recipe = await readXiachufangRecipe(url.href);
        project.source = formatXiachufangRecipe(recipe);
        return project.source;
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`网页读取失败：HTTP ${response.status}，可以粘贴正文继续。`);
      const html = await response.text();
      const $ = load(html);
      $("script, style, nav, footer, noscript").remove();
      const body = $("article").first().text() || $("main").first().text() || $("body").text();
      const text = body.replace(/\s+/g, " ").trim();
      if (!text) throw new Error("网页没有可读取的正文，请粘贴原文。");
      if (text.length > 100000) throw new Error("网页内容过长，请粘贴需要解读的段落。");
      // 保存本次实际使用的原文，后续阶段无需重新访问网页。
      project.source = text;
      return text;
    },
    {
      name: "read_source",
      description: "读取用户指定的素材网页。原始材料为空且有链接时，必须先调用此工具。",
      schema: z.object({}),
    },
  );
}

function createXiachufangTools() {
  return [
    tool(async ({ keyword }) => searchXiachufang(keyword), {
      name: "search_xiachufang",
      description: "仅在明确制作中国味道图鉴且没有可用单篇菜谱时，按当期菜名查找下厨房候选。返回链接仅供本次选择，不写入材料解读。",
      schema: z.object({ keyword: z.string().min(1).max(40) }),
    }),
    tool(async ({ url }) => formatXiachufangRecipe(await readXiachufangRecipe(url)), {
      name: "read_xiachufang_recipe",
      description: "读取搜索结果中选定的一篇下厨房菜谱的食材和步骤。只采用这一版本，不记录作者或链接，不拼接其他菜谱。",
      schema: z.object({ url: z.url() }),
    }),
  ];
}

// 阶段策略同时决定提示词能力和实际工具，避免“提示词禁用但工具仍可用”。
export function buildAgentTools({ project, stage, operation, instruction = "", skills, onStatus }: ToolFactoryOptions) {
  const references = hasCapability(stage, "references", operation)
    ? createArticleReferenceAccess(project, message => onStatus?.(message))
    : undefined;
  const tools = [
    ...(project.url && hasCapability(stage, "source", operation) ? [createReadSourceTool(project)] : []),
    ...(skills && hasCapability(stage, "writing-skill", operation) ? [skills.tool] : []),
    ...(references ? references.tools : []),
    // 系列无链接时可在材料解读阶段选一篇真实菜谱；其余阶段只使用已确认的解读。
    ...(project.topicId === "tech123" && stage === "analysis" &&
      /中国味道图鉴/.test(`${project.source}\n${instruction}`) ? createXiachufangTools() : []),
  ];
  return {
    tools,
    references,
    assertReady: () => references?.assertComplete(),
  };
}
