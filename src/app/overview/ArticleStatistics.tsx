"use client";
import { useCallback, useEffect, useState } from "react";
import type { WritingTopicSummary } from "../../lib/project";
import type { Metric, Statistics } from "../../lib/wechat/statistics";
import { beijingToday, FIRST_DATE, shiftDate } from "../../lib/wechat/dates";

const windows = [1, 3, 7, 14, 30, 90, 180, 365];
const labels: Record<Metric, string> = { read_user: "阅读", share_user: "分享", zaikan_user: "爱心赞", like_user: "拇指赞", comment_count: "留言", collection_user: "收藏" };
const number = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");
type Result = Statistics & { requestedStart: string; historyLimited: boolean };
// 空缺保持断线；图形下方同时提供逐点表格，颜色不是唯一的信息载体。
function TrendChart({ data, metric }: { data: Statistics["chart"]; metric: Metric }) {
  const width = 760, height = 230, left = 55, bottom = 195;
  const max = Math.max(1, ...data.map(item => item.values[metric] ?? 0));
  const x = (index: number) => left + index / Math.max(1, data.length - 1) * (width - left - 25);
  const y = (value: number) => bottom - value / max * 165;
  const paths: string[] = []; let points: string[] = [];
  for (const [index, item] of data.entries()) {
    if (item.values[metric] === null) { if (points.length) paths.push(points.join(" ")); points = []; }
    else points.push(`${x(index)},${y(item.values[metric]!)}`);
  }
  if (points.length) paths.push(points.join(" "));
  return <><svg className="wx-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${labels[metric]}趋势，缺失或延迟的数据留空`}>
    {[0, 0.5, 1].map(fraction => <g key={fraction}><line x1={left} y1={y(max * fraction)} x2={width - 20} y2={y(max * fraction)} stroke="#dce3df" />
      <text x={left - 8} y={y(max * fraction) + 4} textAnchor="end" fontSize="11" fill="#666">{Math.round(max * fraction).toLocaleString()}</text></g>)}
    {paths.map((path, index) => <polyline key={index} points={path} fill="none" stroke="#286653" strokeWidth="2.5" />)}
    {data.map((item, index) => item.values[metric] !== null && <circle key={item.start} cx={x(index)} cy={y(item.values[metric]!)} r="3" fill="#286653"><title>{item.start} 至 {item.end}：{item.values[metric]}</title></circle>)}
    <text x={left} y={220} fontSize="11" fill="#666">{data[0]?.start}</text><text x={width - 20} y={220} textAnchor="end" fontSize="11" fill="#666">{data.at(-1)?.end}</text>
  </svg><details className="wx-chart-table"><summary>查看图表数据</summary><table><thead><tr><th>日期范围</th><th>{labels[metric]}</th></tr></thead>
    <tbody>{data.map(item => <tr key={item.start}><td>{item.start} — {item.end}{item.partial ? "（非完整周/月）" : ""}</td><td>{number(item.values[metric])}</td></tr>)}</tbody></table></details></>;
}
export default function ArticleStatistics({ topics }: { topics: WritingTopicSummary[] }) {
  const available = topics.filter(topic => topic.publish?.enabled);
  const [topicId, setTopicId] = useState(available[0]?.id ?? ""), [days, setDays] = useState("7");
  const [customStart, setCustomStart] = useState(shiftDate(beijingToday(), -7)), [customEnd, setCustomEnd] = useState(shiftDate(beijingToday(), -1));
  const [applied, setApplied] = useState<{ start: string; end: string } | null>(null);
  const [articleId, setArticleId] = useState(""), [metric, setMetric] = useState<Metric>("read_user");
  const [data, setData] = useState<Result | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [refreshing, setRefreshing] = useState(false), [page, setPage] = useState(0), [reload, setReload] = useState(0);
  const query = useCallback(() => {
    const params = new URLSearchParams({ topicId, articleId });
    if (days === "custom" && applied) { params.set("start", applied.start); params.set("end", applied.end); }
    else params.set("days", days === "custom" ? "7" : days);
    return params.toString();
  }, [topicId, articleId, days, applied]);
  useEffect(() => {
    if (!topicId) return;
    const controller = new AbortController();
    let flight = false;
    setData(null); setPage(0); setError("");
    const load = async () => {
      if (flight) return; flight = true;
      try {
        const response = await fetch(`/api/wechat/statistics?${query()}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setData(result); setError("");
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "统计读取失败"); }
      finally { flight = false; }
    };
    void load(); const timer = setInterval(() => void load(), 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [topicId, query, reload]);
  async function refresh() {
    setRefreshing(true); setError("");
    try {
      const response = await fetch("/api/wechat/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topicId }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setMessage(result.message); setReload(value => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "刷新失败"); }
    finally { setRefreshing(false); }
  }
  if (!available.length) return <section className="overview-section"><h2>文章统计</h2><p>尚无配置 publish 的专题，请先配置公众号信息。</p></section>;
  const currentTopic = available.find(topic => topic.id === topicId);
  const counts = data?.sync.counts ?? {};
  return <section className="overview-section wx-statistics" aria-labelledby="wx-statistics-title">
    <header className="wx-statistics-heading"><div><h2 id="wx-statistics-title">文章统计</h2><p>对应公众号全部发表文章 · 数据不参与风格学习</p></div>
      <button onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "正在加入队列…" : "刷新公众号数据"}</button></header>
    <div className="wx-statistics-controls"><label>专题 <select value={topicId} onChange={event => { setTopicId(event.target.value); setArticleId(""); setMessage(""); }}>
      {available.map(topic => <option key={topic.id} value={topic.id}>{topic.name}</option>)}</select></label>
      <label>时间范围 <select value={days} onChange={event => setDays(event.target.value)}>{windows.map(value => <option key={value} value={value}>最近 {value} 天</option>)}<option value="custom">自定义日期</option></select></label>
      {days === "custom" && <><label>开始 <input type="date" min={FIRST_DATE} max={customEnd} value={customStart} onChange={event => setCustomStart(event.target.value)} /></label>
        <label>结束 <input type="date" min={customStart} max={shiftDate(beijingToday(), -1)} value={customEnd} onChange={event => setCustomEnd(event.target.value)} /></label>
        <button onClick={() => setApplied({ start: customStart, end: customEnd })}>查看区间</button></>}
    </div>
    {currentTopic?.publish?.error && <p role="alert" className="wx-error">{currentTopic.publish.error}</p>}
    {error && <p role="alert" className="wx-error">{error}</p>}{message && <p role="status">{message}</p>}
    {!data && !error && <p role="status">正在读取已保存的统计…</p>}
    {data && <>
      <div className="wx-sync-status"><p>已完成 {counts.complete ?? 0} 项 · 待获取 {counts.pending ?? 0} 项 · 延迟 {counts.delayed ?? 0} 项 · 失败 {counts.failed ?? 0} 项</p>
        <p>最近获取：{data.sync.lastFetchedAt ? new Date(data.sync.lastFetchedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未获取"}</p>
        <p>账号日数据已获取 {data.sync.coverage.days} 天：{data.sync.coverage.first ?? "—"} 至 {data.sync.coverage.last ?? "—"}（可能存在缺口）。每天北京时间 09:00 更新，服务停机后自动补取。</p>
        {data.sync.pendingRange && <p>待补日期：{(data.sync.pendingRange as { first: string | null }).first ?? "无"} 至 {(data.sync.pendingRange as { last: string | null }).last ?? "无"}</p>}
        {data.sync.unavailableSources.map(source => <p key={source.source} className="wx-source-unavailable">{source.label}接口暂无权限：{source.error ?? "请检查公众号认证与权限"}。已跳过，其他接口仍会继续同步。</p>)}
        {data.sync.error && <p role="alert" className="wx-error">{data.sync.error}</p>}</div>
      {data.historyLimited && <p>请求区间包含 {FIRST_DATE} 之前的日期，该部分接口不提供数据，不作完整周期比较。</p>}
      <p className="wx-period">{data.range.start} — {data.range.end} · 对比 {data.range.previousStart} — {data.range.previousEnd}</p>
      {articleId && <div className="wx-article-selected"><button onClick={() => setArticleId("")}>返回账号统计</button><h3>{data.selectedArticle?.title}</h3><p>单篇日趋势提供阅读和分享；其他指标见下方累计详情。</p></div>}
      <div className="wx-metrics">{data.summary.filter(item => !articleId || ["read_user", "share_user"].includes(item.metric)).map(item => <div key={item.metric}>
        <span>{item.label}{item.metric === "comment_count" ? "条数" : "每日人数合计"}</span><strong>{number(item.value)}</strong>
        <small>{item.complete ? item.change === null ? "前期不足或基数为零" : `${item.change >= 0 ? "+" : ""}${item.change}% 较前期` : `数据未完整 · ${item.availableDays}/${item.days} 天有值`}</small>
      </div>)}</div>
      <p className="wx-statistics-summary">{data.description}</p>
      <div className="wx-chart-heading"><h3>趋势</h3><label>指标 <select value={metric} onChange={event => setMetric(event.target.value as Metric)}>
        {Object.entries(labels).filter(([key]) => !articleId || ["read_user", "share_user"].includes(key)).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
        <span>按{data.range.granularity === "day" ? "日" : data.range.granularity === "week" ? "周" : "月"}汇总 · 空缺不代表零</span></div>
      <TrendChart data={data.chart} metric={metric} />
      {articleId ? <section className="wx-cumulative"><h3>发表后 30 天内累计详情</h3><p>这是截至统计日的累计快照，不代表当前筛选区间增量或终身累计。</p>
        {data.total ? <><p>快照日期：{data.total.date}{data.total.delayed ? " · 待更新或微信数据仍有延迟" : ""}</p><dl>{Object.entries({ ...labels, read_finish_rate: "阅读完成率", read_avg_activetime: "平均阅读时长（分钟）", read_subscribe_user: "阅读后关注", praise_money: "赞赏金额（分）" }).map(([key, label]) => <div key={key}><dt>{label}</dt>
          <dd>{typeof data.total!.values[key] === "number" ? key === "read_finish_rate" ? `${Math.round(Number(data.total!.values[key]) * 10000) / 100}%` : number(Number(data.total!.values[key])) : "—"}</dd></div>)}</dl></>
          : <p>尚无可用累计明细，可能仍在补取或不在接口统计范围。</p>}</section>
        : <section><h3>文章列表</h3><p>{data.articleDaysComplete ? "按本期每日阅读人数合计排序。" : "单篇日数据尚未完整，下表仅显示已获取数据，排名暂供参考。"}</p>
          <div className="wx-table-scroll"><table className="wx-articles-table"><thead><tr><th>文章</th><th>发表日期</th><th>阅读人数合计</th><th>分享人数合计</th><th>详情</th></tr></thead>
            <tbody>{data.articles.slice(page * 20, (page + 1) * 20).map(article => <tr key={article.id}><td>{/^https?:\/\//.test(article.url) ? <a href={article.url} target="_blank" rel="noreferrer">{article.title}</a> : article.title}</td>
              <td>{article.publishedAt ?? "待补齐"}</td><td>{number(article.read)}</td><td>{number(article.share)}</td><td><button onClick={() => { setArticleId(article.id); setMetric("read_user"); }}>查看</button></td></tr>)}</tbody></table></div>
          {!data.articles.length && <p>此区间暂无文章记录；历史数据可能仍在补取。</p>}
          {data.articles.length > 20 && <div className="wx-pagination"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page + 1} / {Math.ceil(data.articles.length / 20)}</span><button disabled={(page + 1) * 20 >= data.articles.length} onClick={() => setPage(value => value + 1)}>下一页</button></div>}
        </section>}
      <p className="wx-statistics-note">人数按每日值相加，不能视为整个区间去重人数。单篇累计明细仅统计发表日起 30 天；账号日数据与单篇日阅读、分享长期保存。</p>
    </>}
  </section>;
}
