import ArticleStatistics from "./ArticleStatistics";
import { listWritingTopics } from "../../lib/topics";
import Link from "next/link";
import { articleOverview } from "../../lib/overview";
import { stageLabels } from "../../lib/project";
import TrendEvidence from "./TrendEvidence";
import { requireAuth } from "../../lib/auth";
import { redirect } from "next/navigation";

const trendLabels = { active: "已启用", observing: "观察中", conflicted: "冲突暂停", disabled: "已停用" };

export const dynamic = "force-dynamic";

// 概览保留汇总为主，原始修改仅在点击具体倾向后按需读取。
export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  // 概览在服务端读取 SQLite，先守卫才能避免未登录请求参与数据计算。
  if (await requireAuth()) redirect("/login");
  const requested = (await searchParams).tab;
  const tab = requested === "style" || requested === "articles" ? requested : "architecture";
  // 风格统计按需读取，切换公众号统计不触发风格证据计算。
  const topics = tab === "style" ? await articleOverview() : [];
  const writingTopics = tab === "articles" ? await listWritingTopics() : [];
  return <main className="overview-page">
    <header className="overview-header">
      <div><p className="overview-eyebrow">Article / 工作台概览</p><h1>从材料到成稿</h1>
        <p>所有专题共用四步写作流程，专题规则与风格记忆各自独立。</p></div>
      <Link href="/">返回写作台</Link>
    </header>
    <nav className="overview-tabs" aria-label="统计分类">{[["architecture", "架构"], ["style", "风格统计"], ["articles", "文章统计"]].map(([id, label]) =>
      <Link key={id} href={`/overview?tab=${id}`} aria-current={tab === id ? "page" : undefined}>{label}</Link>)}</nav>
    {tab === "articles" && <ArticleStatistics topics={writingTopics} />}
    {tab === "architecture" && <section className="overview-section" aria-labelledby="workflow-title">
      <h2 id="workflow-title">当前项目架构</h2>
      <ol className="overview-flow">
        <li><b>01</b><strong>材料解读</strong><span>保存材料与分析，确认后进入选题。</span></li>
        <li><b>02</b><strong>选题与方向</strong><span>确定标题，调整核心方向并一同确认。</span></li>
        <li><b>03</b><strong>写作大纲</strong><span>按当前专题的结构规则组织内容。</span></li>
        <li><b>04</b><strong>正文与成稿</strong><span>保留版本；成稿时只按重大结构变化修订本篇大纲。</span></li>
      </ol>
      <p className="overview-dataflow">项目、阶段成果、正文版本和学习证据统一保存 → 按专题整理表达偏好 → 可用偏好注入后续写作 → 成稿后观察修改变化。</p>
    </section>}
    {tab === "style" && <section className="overview-section" aria-labelledby="memory-title">
      <h2 id="memory-title">风格学习观察</h2>
      <p>以下修改次数为正文意见条数加手动编辑时段；同一轮手动正文编辑无论持续多久都合并，反馈、模型生成或恢复版本会开启下一轮。统计每篇最近成稿，从本轮初稿到成稿，避免重复成稿缩短统计区间。成稿和未修改不代表满意。</p>
      <div className="overview-topics">{topics.map(topic => <article className="overview-topic" key={topic.topicId}>
        <div className="overview-topic-heading"><h3>{topic.name}</h3><span>{topic.projectCount} 个项目 · {topic.finalizedCount} 篇成稿</span></div>
        <dl className="overview-metrics">
          <div><dt>用户修改证据</dt><dd>{topic.evidenceCount}</dd></div>
          <div><dt>已启用倾向</dt><dd>{topic.trendCounts.active}</dd></div>
          <div><dt>调用时注入记忆</dt><dd>{topic.usageCount}</dd></div>
          <div><dt>待整理证据</dt><dd>{topic.pendingCount}</dd></div>
        </dl>
        <p className="overview-detail">画像：观察中 {topic.trendCounts.observing} · 冲突 {topic.trendCounts.conflicted} · 停用 {topic.trendCounts.disabled}；整理：成功 {topic.runCounts.succeeded} · 失败 {topic.runCounts.failed}</p>
        {/* 分开显示学习产物、实际使用和后续修改，避免把注入次数当成质量提升。 */}
        <div className="overview-evaluation"><strong>学习效果：{topic.assessment}</strong>
          <p>当前画像 {topic.latestVersion === null ? "尚未形成" : `v${topic.latestVersion}`} · 缺少初稿或可追溯调用记录：{topic.unknownCount} 篇（不纳入两组比较）</p>
          <p>最近 {topic.recentCount} 篇：{topic.recentAverage ?? "—"} 次 / 篇；此前 {topic.previousCount} 篇：{topic.previousAverage ?? "—"} 次 / 篇</p>
          <p>发生手动正文修改：{topic.manualRate === null ? "—" : `${topic.manualRate}%`}；初稿使用记忆：{topic.assistedCount} 篇</p>
          <p>初稿使用记忆：{topic.assistedAverage ?? "—"} 次 / 篇（{topic.assistedCount} 篇）；初稿未使用：{topic.unassistedAverage ?? "—"} 次 / 篇（{topic.unassistedCount} 篇）</p>
          <p>初稿至成稿文字变化：使用记忆 {topic.assistedChange === null ? "—" : `${topic.assistedChange}%`}；未使用 {topic.unassistedChange === null ? "—" : `${topic.unassistedChange}%`}</p>
          <p className="overview-sample">文字变化按去空白后的相邻双字重合度计算，越低表示文字越接近；无法衡量语义、段落顺序或风格遵循程度，也不代表越低越好。两组为自然使用记录，不是对照实验。</p>
          {(topic.recentCount < 5 || topic.previousCount < 5) && <p className="overview-sample">最近与此前各达到 5 篇成稿后，再观察时间趋势。</p>}
        </div>
        {topic.articles.length ? <ol className="overview-articles">{topic.articles.map(item => <li key={item.id}>
          <span title={item.title}>{item.title}</span><small>{new Date(item.date).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</small>
          <b>{item.feedbackCount} 条意见 · {item.manualSessions} 次编辑</b><em>{item.styleUsed === null ? "记忆记录未知" : item.styleUsed ? `使用画像 v${item.versionId ?? "—"}` : "未使用记忆"}</em>
          <small className="overview-article-effect">文字变化 {item.changePercent === null ? "—" : `${item.changePercent}%`} · 最后模型稿至成稿 {item.finalTouchPercent === null ? "—" : `${item.finalTouchPercent}%`} · 生成 / 改写 {item.generatedCount} 次</small>
        </li>)}</ol> : <p className="overview-empty">尚无成稿文章，统计会在点击“成稿”后出现。</p>}
        <details className="overview-learning"><summary>学到了什么 · {topic.trendDetails.length} 条倾向</summary>
          {topic.trendDetails.length ? topic.trendDetails.map(trend => <div key={trend.id}>
            <p><strong>{trend.text}</strong></p><p>{stageLabels[trend.stage]} · {trend.scene} · {trendLabels[trend.status]}</p>
            <p>{trend.evidenceCount} 条依据 / {trend.projectCount} 篇文章；已用于 {trend.usedArticles} 篇成稿初稿，后续平均 {trend.editAverage ?? "—"} 次修改。</p>
            <TrendEvidence topicId={topic.topicId} eventIds={trend.evidenceIds} evidenceCount={trend.evidenceCount} />
          </div>) : <p>尚未形成倾向；正常写作、修改或明确说明长期偏好后，会逐步积累。</p>}
          <p>引用倾向后的修改次数仅用于定位待评审的偏好，不代表该倾向已被遵循。</p>
        </details>
        <details className="overview-learning"><summary>画像如何变化</summary>
          {topic.profileChanges.length ? topic.profileChanges.map(version => <p key={version.id}>
            v{version.id} · {new Date(version.date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} · {version.reason}
            {version.added === null ? " · 无前一版本可比较" : ` · 新增 ${version.added} 条，调整 ${version.changed} 条`}
          </p>) : <p>尚无画像版本。</p>}
        </details>
      </article>)}</div>
    </section>}
  </main>;
}
