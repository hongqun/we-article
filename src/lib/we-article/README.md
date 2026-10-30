# 独立写作入口

访问 `/we-article`，不需要登录。旧工作台及导航保持原样。

## 代码组织

- `src/app/we-article/` 的页面负责展示，`useWritingWorkspace.ts` 管理编辑、保存、切换和对话状态。
- `src/app/api/we-article/` 处理 HTTP 请求和流式事件；`writing-service.ts` 协调一轮写作的 Agent 和提交。
- `store.ts` 管理独立数据库，`agent.ts` 管理写作工具；`config.ts` 读取项目配置，模型适配与追踪各自独立。

## 数据与配置

- 新库固定为项目根目录的 `data/we-article.db`，首次调用文章接口时初始化，不读取或迁移旧数据库。
- 文章包含标题、Markdown 正文、时间和按序保存的对话；粘贴材料与要求作为用户对话保存。网页素材在整轮成功后作为折叠消息保存来源、读取时间和正文，后续对话继续使用。
- 正文面板可切换排版预览，选择六种内置风格并复制富文本；标题和配图在公众号后台单独处理。
- MVP 模型配置只读取项目根目录 `.we-article.env` 中的 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL`、`MODEL_PROVIDER` 和 `STREAMING`，不读取旧工作台的模型配置。通用 OpenAI Chat Completions 兼容接口使用 `MODEL_PROVIDER=openai`，模型须支持工具调用。
- DeepSeek 思考模式使用 `MODEL_PROVIDER=deepseek`，并通过 `THINKING_ENABLED`、`REASONING_EFFORT` 配置。通用模式不发送 DeepSeek 专有思考参数。 DeepSeek 适配器在 `completionWithRetry` 请求构造边界补回工具调用所需的 `reasoning_content`，复用官方集成的响应解析，不拦截 HTTP 请求。
- 写作技能位于 `.agents/skills/`：`we-article-workflow` 负责协作流程，`we-article-analysis`、`we-article-topic`、`we-article-outline` 分别负责材料解读、选题和大纲，`we-article-writing` 和 `we-article-revision` 负责正文创作与修改。宽泛主题默认先讨论选题，再讨论大纲；用户明确要求直接写作或跳过讨论时可以跳过。中间讨论保存在文章对话中。
- 该入口及 `/api/we-article/` 接口均无需会话，能访问服务的人可以读写本入口的文章。

## 第四期：账号与专题

顶部“账号与专题”打开独立管理窗口。账号保存长期定位、读者与共用写作要求；一个账号下可以建立多个专题，专题只保存内容方向、文章形态与特殊要求的差异。新配置只包含名称与自然语言规则，不读取旧专题 JSON 或阶段提示词。

- 新建或编辑时，左侧与配置助手对话，右侧检查和直接修改草稿。离开当前草稿时保留已整理的内容，也可点击“保留草稿”；未发送的输入不会自动提交。只有点击“确认保存”才创建或更新正式账号／专题，未完成草稿可从目录恢复。
- 新建文章和空白页首次发送时，有已保存账号才弹出配置选择。可以只选账号、选择账号下的专题或跳过；没有配置时直接继续。首次发送的材料保留到提交对话成功。当前文章的归属按钮可查看或更换配置，更换不改写已有正文与对话。
- “文章”列表支持搜索、按账号筛选和勾选单篇／多篇文章，点击“提炼为专题”后在配置对话中生成草稿。一次最多 20 篇，正文合计最多 200,000 字符，空稿不能提炼。当前文章如有手改会先保存。提炼保留当时的标题与正文快照，来源可展开查看；确认专题不改变来源文章归属。没有账号时可在专题草稿内新建账号，再返回继续保存专题。
- 每轮写作由应用按文章归属读取最新正式配置，优先尊重本篇明确要求。来源文章不随专题配置注入写作事实上下文。风格学习仍为后续能力，本期不根据生成结果或保存行为学习。

数据仍保存在 `data/we-article.db`，新增 `writing_accounts`、`writing_topics` 和 `configuration_sessions`。旧文章增加可空的账号与专题关联，保留原文和对话；不迁移旧工作台的专题与数据库。

配置接口为 `GET /api/we-article/configuration`、`POST /api/we-article/configuration/sessions`、`GET/PUT/POST /api/we-article/configuration/sessions/[id]`。创建配置会话提交 `{kind,accountId?,targetId?,sourceArticleIds?}`；草稿保存提交 `{draft:{name,content},accountId}`；对话提交同样字段加 `{action:"message",instruction}`，确认提交 `{action:"confirm"}`。模型只更新候选草稿，确认接口在事务中写入正式配置。

文章创建接口接受可选的 `{accountId,topicId}`，不传继续使用通用规则；`PATCH /api/we-article/articles/[id]` 单独更新归属。专题必须属于所选账号，编辑已有专题时保持所属账号不变。

本期仅执行类型与差异检查，未启动服务或运行测试；实际数据库迁移、模型配置对话和浏览器交互尚待运行验证。

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
`POST /api/we-article/articles/[id]/chat` 和 `POST /api/we-article/layout`（排版预览）。保存提交 `{title,body}`，对话提交 `{instruction}`。
对话响应为 NDJSON，事件包括 `accepted`、`status`、`reasoning`、`reply`、`done`、`error`；推理片段仅用于实时展示。

实现后仅进行类型、差异和依赖边界检查。真实模型、数据库读写和浏览器交互需要另行运行验证。
