# We-Article 项目约定

- 本项目独立运行，只读取项目根目录的 .env；不要依赖同级其他项目或原仓库路径。
- 文章数据、风格记忆和封面均由 data/ 管理；专题配置与提示词位于 topics/。
- 运行时写作技能及其依赖资源位于 .agents/skills/，保持完整相对路径。
- 配置、数据库和密钥处理遵循 README；不要将 .env、SQLite 临时文件或登录日志提交。
- 代码修改附近补充简洁中文注释；按需执行检查，未获明确要求时不启动服务或运行测试。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
