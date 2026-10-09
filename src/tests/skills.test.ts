import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSkillAccess } from "../lib/skills";

// 使用临时技能验证加载边界，不访问网络、不调用模型或真实项目资料。
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "article-skills-"));
  const root = path.join(base, "skills");
  const skill = path.join(root, "example");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: example\ndescription: |\n  本地测试技能\n---\n入口规则\n");
  await writeFile(path.join(skill, "references", "revision.md"), "改稿规则");
  return { base, root, skill };
}

test("目录只包含元数据，入口必须真实读取，参考按需加载", async () => {
  const { base, root } = await fixture();
  try {
    const access = await createSkillAccess(["example"], root);
    assert.equal(access.catalog[0].description, "本地测试技能");
    assert.equal(JSON.stringify(access.catalog).includes("入口规则"), false);
    assert.throws(() => access.assertActivated(), /未成功读取/);
    await access.tool.invoke({ file: "example/references/revision.md" });
    assert.throws(() => access.assertActivated(), /未成功读取/);
    const result = await access.tool.invoke({ file: "example/SKILL.md" });
    assert.match(JSON.stringify(result), /入口规则/);
    access.assertActivated();
    // 新请求不能沿用上次激活状态。
    const next = await createSkillAccess(["example"], root);
    assert.throws(() => next.assertActivated(), /未成功读取/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("阻止越界、符号链接、未启用技能和缺失文件", async () => {
  const { base, root, skill } = await fixture();
  try {
    await writeFile(path.join(base, "private.txt"), "不可读取");
    await symlink(path.join(base, "private.txt"), path.join(skill, "escape.txt"));
    const access = await createSkillAccess(["example"], root);
    for (const file of ["example/../../private.txt", "example/escape.txt", "other/SKILL.md", "example/missing.md", path.join(base, "private.txt")]) {
      await assert.rejects(access.tool.invoke({ file }));
    }
    assert.throws(() => access.assertActivated(), /未成功读取/);
    await assert.rejects(createSkillAccess(["missing"], root), /未安装/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("无效元数据明确报错，不静默使用不完整技能", async () => {
  const { base, root, skill } = await fixture();
  try {
    await writeFile(path.join(skill, "SKILL.md"), "缺少元数据");
    await assert.rejects(createSkillAccess(["example"], root), /缺少 YAML/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
