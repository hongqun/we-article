import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRuntimeInstruction, buildSystemPrompt, getStageProfile } from "../lib/prompt-builder";
import { buildAgentTools } from "../lib/agent-tools";
import { newProject } from "../lib/project";

test("材料解读只装配材料分析规则，不装配正文和 Skill 规则", async () => {
  const prompt = await buildSystemPrompt({ topicId: "tech123", stage: "analysis", operation: "stage" });
  assert.equal((prompt.match(/你是个人文章写作助手/g) ?? []).length, 1);
  assert.equal((prompt.match(/## 核心问题与已有信息/g) ?? []).length, 1);
  assert.match(prompt, /核心问题与已有信息/);
  assert.match(prompt, /可行文章形态/);
  assert.doesNotMatch(prompt, /面向科技兴趣读者/);
  assert.doesNotMatch(prompt, /正文结构：/);
  assert.doesNotMatch(prompt, /大家好/);
  assert.doesNotMatch(prompt, /read_skill_file/);
  assert.doesNotMatch(prompt, /配图服务于效果展示/);
  assert.doesNotMatch(prompt, /search_articles/);
});

test("正文阶段仍装配专题正文规则和参考文章能力", async () => {
  const prompt = await buildSystemPrompt({ topicId: "tech123", stage: "article", operation: "stage" });
  assert.match(prompt, /AI 生成画面/);
  assert.match(prompt, /配图要求/);
  assert.match(prompt, /参考文章/);
  assert.deepEqual(getStageProfile("article", "stage").capabilities, ["source", "references", "writing-skill"]);
});

test("见隙各阶段装配本地专题提示词并保留固定边界", async () => {
  const analysis = await buildSystemPrompt({ topicId: "jianxi", stage: "analysis", operation: "stage" });
  assert.match(analysis, /见隙专题优先使用下面的固定结构/);
  for (const heading of ["核心论点与内在逻辑", "可继承的优点", "可拓展视角", "与见隙专题的连接点"]) {
    assert.equal((analysis.match(new RegExp(`## ${heading}`, "g")) ?? []).length, 1);
  }
  assert.match(analysis, /不采用共享分析规则中的“可行文章形态”额外章节/);

  const topics = await buildSystemPrompt({ topicId: "jianxi", stage: "topics", operation: "stage" });
  assert.match(topics, /一段40—80字/);
  assert.match(topics, /未指定标题数量时默认输出五个/);

  const article = await buildSystemPrompt({ topicId: "jianxi", stage: "article", operation: "stage" });
  assert.match(article, /每个正文自然段以 100—150 字为目标/);
  assert.match(article, /仅三个正文自然段/);
});

test("Tech123 本地写作思路针对 AI 视觉文章合并提示词拆解", async () => {
  const prompt = await buildSystemPrompt({ topicId: "tech123", stage: "outline", operation: "stage" });

  assert.match(prompt, /3—4 条简短的内容推进要点/);
  assert.match(prompt, /每条只说明核心内容和必要材料/);
  assert.match(prompt, /效果 → 必要应用或做法 → 可复制模板/);
  assert.match(prompt, /不要把提示词逐句、逐层、逐参数拆开/);
  assert.doesNotMatch(prompt, /每点写清本篇要讲的具体内容、所依赖的材料及与前后部分的关系/);
  assert.doesNotMatch(prompt, /引言加三到四个部分可作为参考/);
});

test("公开示例提示词简洁，个人完整提示词只在忽略的本地目录", () => {
  const root = process.cwd();
  for (const id of ["jianxi", "tech123"]) {
    for (const file of ["rules.md", "prompts/analysis.md", "prompts/topics.md", "prompts/outline.md", "prompts/article.md"]) {
      const example = readFileSync(path.join(root, "topics", id, file), "utf8");
      const local = readFileSync(path.join(root, "data/local/topics", id, file), "utf8");
      assert.ok(example.length < local.length, `${id}/${file} 示例应比本地个人提示词简短`);
    }
  }
});

test("工具集合与阶段能力保持一致", () => {
  const project = newProject("jianxi");
  const analysis = buildAgentTools({ project, stage: "analysis", operation: "stage" });
  assert.deepEqual(analysis.tools.map(tool => tool.name), []);
  assert.equal(analysis.references, undefined);

  const article = buildAgentTools({ project, stage: "article", operation: "stage" });
  assert.deepEqual(article.tools.map(tool => tool.name), ["search_articles", "read_article"]);
  assert.ok(article.references);
});

test("选题上下文按原始材料、材料解读和已有成果分区", () => {
  const content = buildRuntimeInstruction({
    projectData: {
      source: "原始提示词素材",
      url: "",
      results: { analysis: "材料解读内容", topics: "旧选题成果" },
      selectedTopic: "已选标题",
    },
    instruction: "请生成完整的选题与方向。",
  });

  assert.match(content, /【原始材料】[\s\S]*原始提示词素材/);
  assert.match(content, /【材料解读】[\s\S]*材料解读内容/);
  assert.match(content, /【已有选题成果】[\s\S]*旧选题成果/);
  assert.match(content, /【已选标题】[\s\S]*已选标题/);
  assert.ok(content.indexOf("【原始材料】") < content.indexOf("【材料解读】"));
  assert.ok(content.indexOf("【材料解读】") < content.indexOf("【已有选题成果】"));
});
