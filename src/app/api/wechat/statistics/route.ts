import { NextResponse } from "next/server";
import { publishConfig } from "../../../../lib/wechat/config";
import { articleStatistics } from "../../../../lib/wechat/statistics";
import { beijingToday, FIRST_DATE, shiftDate } from "../../../../lib/wechat/dates";
import { startWechatScheduler } from "../../../../lib/wechat/sync";
import { apiError } from "../../../../lib/wechat/http";
import { requireAuth } from "../../../../lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 页面只读已落盘数据；后台调度异步补齐，不让历史请求阻塞图表。
export async function GET(request: Request) {
  const unauthorized = await requireAuth(); if (unauthorized) return unauthorized;
  try {
    const query = new URL(request.url).searchParams, config = await publishConfig(query.get("topicId") ?? "");
    if (!config) throw new Error("此专题未配置公众号。");
    const end = query.get("end") ?? shiftDate(beijingToday(), -1);
    const days = Number(query.get("days") ?? 7);
    if (![1, 3, 7, 14, 30, 90, 180, 365].includes(days)) throw new Error("不支持的统计窗口。");
    const start = query.get("start") ?? shiftDate(end, 1 - days);
    // 预设窗口可超出官方历史起点，保留原区间并在返回数据标记缺失；自定义范围必须有效。
    if (query.has("start") && start < FIRST_DATE) throw new Error(`自定义日期不得早于 ${FIRST_DATE}。`);
    startWechatScheduler();
    return NextResponse.json({ ...articleStatistics(config.AppID, start, end, query.get("articleId") ?? undefined),
      requestedStart: start, historyLimited: start < FIRST_DATE }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
