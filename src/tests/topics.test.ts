import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildImagePrompt } from "../lib/image-prompt";
import { listWritingTopics, loadWritingPrompt, readWritingTopic } from "../lib/topics";

test("本地专题无需代码注册即可发现、覆盖并加载四阶段文件", async () => {
  const localRoot = path.join(process.cwd(), "data", "local", "topics");
  mkdirSync(localRoot, { recursive: true });
  const id = `topic-test-${Date.now()}`;
  const directory = path.join(localRoot, id);
  mkdirSync(directory);
  try {
    writeFileSync(path.join(directory, "topic.json"), JSON.stringify({
      name: "测试专题", description: "配置发现测试", audience: "测试读者", outlineLabel: "结构",
      directionLabel: "说明方向", structure: "按配置结构写作", default: false, workflow: "staged",
      styleMemory: true, imagePromptFile: "image-prompts.md",
    }));
    writeFileSync(path.join(directory, "rules.md"), "测试专题规则");
    mkdirSync(path.join(directory, "prompts"));
    for (const stage of ["analysis", "topics", "outline", "article"])
      writeFileSync(path.join(directory, "prompts", `${stage}.md`), `${stage} 阶段要求`);
    writeFileSync(path.join(directory, "image-prompts.md"), `封面提示词：${"[在此输入文章内容]"}`);

    const topics = await listWritingTopics();
    assert.equal(topics.find(topic => topic.id === id)?.styleMemory, true);
    assert.equal(topics.find(topic => topic.id === id)?.imagePrompt, true);
    const topic = await readWritingTopic(id);
    assert.equal(topic.name, "测试专题");
    const prompt = await loadWritingPrompt(id, "article");
    assert.match(prompt.prompt, /article 阶段要求/);
    assert.match(await buildImagePrompt(id, "一篇测试文章"), /一篇测试文章/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("公开示例不包含发布账号配置或个人参考文件", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const id of ["jianxi", "tech123"]) {
    const topic = JSON.parse(readFileSync(path.join(process.cwd(), "topics", id, "topic.json"), "utf8"));
    assert.equal("publish" in topic, false);
    assert.equal("AppSecret" in topic, false);
    assert.equal("referencesFile" in topic, false);
    assert.equal("imagePromptFile" in topic, false);
    assert.equal(existsSync(path.join(process.cwd(), "topics", id, "references.md")), false);
  }
});
