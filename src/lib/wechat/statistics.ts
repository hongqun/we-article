import { bucketRanges, datesBetween, sourceNames, statisticsRange, type DataSource } from "./dates";
import { wechatStore, type WechatStore, type FetchRow } from "./store";

export const metricNames = { read_user: "阅读", share_user: "分享", zaikan_user: "爱心赞", like_user: "拇指赞",
  comment_count: "留言", collection_user: "收藏" } as const;
export type Metric = keyof typeof metricNames;
export const metrics = Object.keys(metricNames) as Metric[];
type Values = Partial<Record<Metric, number>>;
type Daily = { article_id: string; date: string; source: string; payload: string };
function values(payload: string): Values {
  const object = JSON.parse(payload) as Record<string, unknown>, result: Values = {};
  for (const metric of metrics) if (typeof object[metric] === "number" && Number.isFinite(object[metric])) result[metric] = object[metric] as number;
  return result;
}
export function compareValue(current: number | null, previous: number | null, complete: boolean) {
  return complete && current !== null && previous !== null && previous !== 0 ? Math.round((current - previous) / previous * 1000) / 10 : null;
}
// 汇总使用每日事实数据；累计明细只供单篇详情，不能混入趋势或跨日相加。
export function articleStatistics(account: string, start: string, end: string, articleId?: string, store: WechatStore = wechatStore()) {
  const range = statisticsRange(start, end);
  const rows = store.db.prepare("SELECT article_id,date,source,payload FROM wx_daily WHERE account=? AND date BETWEEN ? AND ?")
    .all(account, range.previousStart, end) as Daily[];
  const fetches = store.db.prepare("SELECT * FROM wx_fetches WHERE account=? AND date BETWEEN ? AND ?")
    .all(account, range.previousStart, end) as FetchRow[];
  const states = new Map(fetches.map(row => [`${row.source}:${row.date}`, row]));
  const daily = new Map(rows.map(row => [`${row.article_id}:${row.source}:${row.date}`, values(row.payload)]));
  const sourceFor = (metric: Metric) => !articleId ? "getbizsummary" : metric === "read_user" ? "getarticleread" : metric === "share_user" ? "getarticleshare" : null;
  function valueFor(date: string, metric: Metric, id = articleId ?? ""): number | null {
    const source = id ? metric === "read_user" ? "getarticleread" : metric === "share_user" ? "getarticleshare" : null : "getbizsummary";
    if (!source) return null;
    const row = daily.get(`${id}:${source}:${date}`);
    if (row) return row[metric] ?? null;
    // 单篇日接口只返回有活动的文章；成功且无延迟的空缺才代表该日没有活动。
    if (id && states.get(`${source}:${date}`)?.state === "complete") return 0;
    return null;
  }
  function aggregate(from: string, to: string, metric: Metric, id = articleId ?? "") {
    const dates = datesBetween(from, to), numbers = dates.map(date => valueFor(date, metric, id));
    const available = numbers.filter((value): value is number => value !== null);
    const source = sourceFor(metric);
    const complete = numbers.every(value => value !== null) && Boolean(source) && dates.every(date => states.get(`${source}:${date}`)?.state === "complete");
    return { value: available.length ? available.reduce((sum, n) => sum + n, 0) : null, complete, availableDays: available.length, days: dates.length };
  }
  const summary = metrics.map(metric => {
    const current = aggregate(start, end, metric), previous = aggregate(range.previousStart, range.previousEnd, metric);
    return { metric, label: metricNames[metric], ...current, previous: previous.value,
      previousComplete: previous.complete, change: compareValue(current.value, previous.value, current.complete && previous.complete) };
  });
  const chart = bucketRanges(start, end, range.granularity).map(bucket => ({ ...bucket,
    values: Object.fromEntries(metrics.map(metric => { const point = aggregate(bucket.start, bucket.end, metric); return [metric, point.complete ? point.value : null]; })) as Record<Metric, number | null> }));
  const articles = store.db.prepare("SELECT msgid,title,url,published_at FROM wx_articles WHERE account=?").all(account) as { msgid: string; title: string; url: string; published_at: string }[];
  const names = new Map(articles.map(article => [article.msgid, article]));
  const ids = new Set([...rows.filter(row => row.article_id && row.date >= start).map(row => row.article_id),
    ...articles.filter(article => article.published_at >= start && article.published_at <= end).map(article => article.msgid)]);
  const listing = [...ids].map(id => {
    const article = names.get(id);
    const reading = datesBetween(start, end).map(date => valueFor(date, "read_user", id));
    const sharing = datesBetween(start, end).map(date => valueFor(date, "share_user", id));
    const sum = (items: (number | null)[]) => items.some(item => item !== null) ? items.reduce<number>((n, item) => n + (item ?? 0), 0) : null;
    return { id, title: article?.title ?? `文章 ${id}（标题待补齐）`, url: article?.url ?? "", publishedAt: article?.published_at ?? null,
      read: sum(reading), share: sum(sharing) };
  }).sort((a, b) => (b.read ?? -1) - (a.read ?? -1));
  const total = articleId ? store.db.prepare("SELECT stat_date,payload FROM wx_totals WHERE account=? AND msgid=? AND stat_date<=? ORDER BY stat_date DESC LIMIT 1")
    .get(account, articleId, end) as { stat_date: string; payload: string } | undefined : undefined;
  const totalState = articleId && names.get(articleId) ? store.db.prepare("SELECT state FROM wx_fetches WHERE account=? AND source='getarticletotaldetail' AND date=?")
    .get(account, names.get(articleId)!.published_at) as { state: string } | undefined : undefined;
  const allCounts = store.db.prepare("SELECT state,COUNT(*) AS count FROM wx_fetches WHERE account=? GROUP BY state").all(account) as { state: string; count: number }[];
  const unavailableSources = store.db.prepare("SELECT source,error,updated_at FROM wx_source_status WHERE account=? AND state='unavailable' ORDER BY source")
    .all(account) as { source: DataSource; error: string | null; updated_at: string }[];
  const coverage = store.db.prepare("SELECT MIN(date) AS first,MAX(date) AS last,COUNT(DISTINCT date) AS days FROM wx_fetches WHERE account=? AND source='getbizsummary' AND state='complete'")
    .get(account) as { first: string | null; last: string | null; days: number };
  const pendingRange = store.db.prepare("SELECT MIN(date) AS first,MAX(date) AS last FROM wx_fetches WHERE account=? AND state NOT IN ('complete','unavailable')").get(account) as { first: string | null; last: string | null };
  const lastFetch = store.db.prepare("SELECT MAX(fetched_at) AS at FROM wx_fetches WHERE account=?").get(account) as { at: string | null };
  const sync = store.db.prepare("SELECT * FROM wx_sync WHERE account=?").get(account) as { last_started: string | null; last_finished: string | null; error: string | null } | undefined;
  const reading = summary[0], sentences: string[] = [];
  if (!reading.complete) sentences.push(`当前区间阅读数据尚未完整，仅有 ${reading.availableDays}/${range.days} 天可用；不作完整周期比较。`);
  else {
    sentences.push(`本期每日阅读人数合计 ${reading.value}，不是跨日去重人数。`);
    if (reading.change !== null) sentences.push(`较此前等长周期${reading.change >= 0 ? "增加" : "减少"} ${Math.abs(reading.change)}%。`);
    else sentences.push("前期数据不完整或基数为零，暂不计算涨跌百分比。");
    const points = datesBetween(start, end).map(date => ({ date, value: valueFor(date, "read_user") ?? 0 })).sort((a, b) => b.value - a.value);
    if (points[0]) sentences.push(`阅读峰值为 ${points[0].date}，当日 ${points[0].value}。`);
  }
  for (const item of summary.slice(1)) {
    if (articleId && item.metric !== "share_user") continue;
    if (!item.complete) continue;
    sentences.push(`${item.label}${item.metric === "comment_count" ? "条数" : "每日人数合计"} ${item.value}${item.change === null ? "，暂无可比涨跌" : `，较前期${item.change >= 0 ? "增加" : "减少"} ${Math.abs(item.change)}%`}。`);
  }
  const articleDaysComplete = datesBetween(start, end).every(date => states.get(`getarticleread:${date}`)?.state === "complete");
  if (!articleId && articleDaysComplete && listing[0]?.read) sentences.push(`本期阅读最多的文章为《${listing[0].title}》，每日阅读人数合计 ${listing[0].read}。`);
  return { range, summary, chart, articles: listing, selectedArticle: articleId ? names.get(articleId) ?? { msgid: articleId, title: articleId } : null,
    total: total ? { date: total.stat_date, delayed: totalState?.state !== "complete", values: JSON.parse(total.payload) as Record<string, unknown> } : null,
    sync: { ...sync, lastFetchedAt: lastFetch.at, counts: Object.fromEntries(allCounts.map(item => [item.state, item.count])), coverage, pendingRange,
      unavailableSources: unavailableSources.map(item => ({ ...item, label: sourceNames[item.source] ?? item.source })) },
    articleDaysComplete, description: sentences.join(" ") };
}
export type Statistics = ReturnType<typeof articleStatistics>;
