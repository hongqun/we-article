import assert from "node:assert/strict";
import test from "node:test";
import { articleContentPlaceholder, assembleImagePrompt, buildImagePrompt } from "../lib/image-prompt";

test("配图提示词只替换一次文章占位符，并保留 Markdown 与代码块", () => {
  const article = "# 标题\n\n正文\n\n```ts\nconst value = 1;\n```";
  const prompt = assembleImagePrompt(`要求\n\n${articleContentPlaceholder}\n\n结束`, article);
  assert.match(prompt, /# 标题/);
  assert.match(prompt, /```ts/);
  assert.equal(prompt.split(article).length - 1, 1);
});

test("空正文和异常占位符会明确拒绝", () => {
  assert.throws(() => assembleImagePrompt(articleContentPlaceholder, "  "), /请先填写正文/);
  assert.throws(() => assembleImagePrompt("没有占位符", "正文"), /必须且只能出现一次/);
  assert.throws(() => assembleImagePrompt(`${articleContentPlaceholder}\n${articleContentPlaceholder}`, "正文"), /必须且只能出现一次/);
});

test("未配置配图模板的专题不能读取配图提示词", async () => {
  await assert.rejects(() => buildImagePrompt("tech123", "正文"), /未配置配图提示词/);
});

test("HTTP 路由认证依赖 Next 请求上下文，纯 Node 测试覆盖其无副作用服务函数", { skip: "路由级认证需 Next 运行时请求上下文；buildImagePrompt 已覆盖组装与配置读取。" }, () => {});
