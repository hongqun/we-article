# 独立写作入口

访问 `/we-article`，不需要登录。旧工作台及导航保持原样。

## 代码组织

- `src/app/we-article/` 的页面负责展示，`useWritingWorkspace.ts` 管理编辑、保存、切换和对话状态。
- `src/app/api/we-article/` 处理 HTTP 请求和流式事件；`writing-service.ts` 协调一轮写作的 Agent 和提交。
- `store.ts` 管理独立数据库，`agent.ts` 管理写作工具；`config.ts` 读取项目配置，模型适配与追踪各自独立。

## 数据与配置

- 新库固定为项目根目录的 `data/we-article.db`，首次调用文章接口时初始化，不读取或迁移旧数据库。
- 文章包含标题、Markdown 正文、时间和按序保存的对话；粘贴材料与要求作为用户对话保存。
- MVP 模型配置只读取项目根目录 `.we-article.env` 中的 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL`、`MODEL_PROVIDER` 和 `STREAMING`，不读取旧工作台的模型配置。通用 OpenAI Chat Completions 兼容接口使用 `MODEL_PROVIDER=openai`，模型须支持工具调用。
- DeepSeek 思考模式使用 `MODEL_PROVIDER=deepseek`，并通过 `THINKING_ENABLED`、`REASONING_EFFORT` 配置。通用模式不发送 DeepSeek 专有思考参数。 DeepSeek 适配器在 `completionWithRetry` 请求构造边界补回工具调用所需的 `reasoning_content`，复用官方集成的响应解析，不拦截 HTTP 请求。
- 写作技能位于 `.agents/skills/`：`we-article-workflow` 负责协作流程，`we-article-analysis`、`we-article-topic`、`we-article-outline` 分别负责材料解读、选题和大纲，`we-article-writing` 和 `we-article-revision` 负责正文创作与修改。宽泛主题默认先讨论选题，再讨论大纲；用户明确要求直接写作或跳过讨论时可以跳过。中间讨论保存在文章对话中。
- 该入口及 `/api/we-article/` 接口均无需会话，能访问服务的人可以读写本入口的文章。

## LangSmith 追踪

同样只读取项目根目录 `.we-article.env`：设置 `LANGSMITH_TRACING=true`、`LANGSMITH_API_KEY`，
通过 `LANGSMITH_PROJECT` 指定项目（默认 `article`），`LANGSMITH_ENDPOINT` 指定区域端点
（默认 `https://api.smith.langchain.com`）；多工作区密钥可设置 `LANGSMITH_WORKSPACE_ID`。
关闭开关或未填写密钥时不创建追踪客户端。

每次对话以“文章标题 · 本轮用户消息开头”为运行名，长消息截取前 24 个字符，便于区分各轮；追踪包含模型和工具子调用，标签为 `we-article`、`mvp`。
元数据保存文章 ID，`thread_id` 使用文章 ID，将同一篇文章的多轮对话关联起来。
模型元数据记录思考开关、思考等级与流式开关。启用后，输入材料、正文和工具内容会上传至配置的 LangSmith。
请求成功或失败后均提交追踪队列，上报失败不会覆盖写作结果。

在 `/we-article` 发送一条消息后，打开 LangSmith 对应项目，按 `we-article` 标签筛选查看。
本次接入仅完成静态检查，尚未执行真实生成或验证云端追踪。

## 保存与失败处理

手工修改点击保存；发送前先保存当前稿；模型更新候选稿后，整轮成功才提交正文和助手回复。
用户输入在模型调用前保存，失败时仍可重新打开。失败后不自动重新发送。
生成期间当前页面暂时禁用编辑。切换或离开页面时保护未保存内容；避免在多个页面同时编辑同一篇文章。

接口为 `GET/POST /api/we-article/articles`、`GET/PUT /api/we-article/articles/[id]` 和
`POST /api/we-article/articles/[id]/chat`。保存提交 `{title,body}`，对话提交 `{instruction}`。
对话响应为 NDJSON，事件包括 `accepted`、`status`、`reasoning`、`reply`、`done`、`error`；推理片段仅用于实时展示。

实现后仅进行类型、差异和依赖边界检查。真实模型、数据库读写和浏览器交互需要另行运行验证。
