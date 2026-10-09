export const FIRST_DATE = "2025-11-01";
export const DAY = 86400000;
export const sources = ["getbizsummary", "getarticleread", "getarticleshare", "getarticletotaldetail"] as const;
export type DataSource = typeof sources[number];
// 接口标识只在服务端存储，展示层使用稳定中文名称说明数据缺口。
export const sourceNames: Record<DataSource, string> = {
  getbizsummary: "用户增减",
  getarticleread: "图文阅读",
  getarticleshare: "图文分享",
  getarticletotaldetail: "图文累计数据",
};
// 日期运算统一以 UTC 日期值计算，北京时间只用于确定今天，避免宿主机时区和夏令时影响。
export function beijingToday(now = new Date()) { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
export function shiftDate(date: string, days: number) { return new Date(Date.parse(date + "T00:00:00Z") + days * DAY).toISOString().slice(0, 10); }
export function datesBetween(start: string, end: string) {
  const dates: string[] = [];
  for (let date = start; date <= end; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}
export function validDate(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value; }
export function statisticsRange(start: string, end: string) {
  if (!validDate(start) || !validDate(end) || start > end || end >= beijingToday()) throw new Error("请选择截至昨日的有效日期范围。");
  if (start < shiftDate(FIRST_DATE, -365)) throw new Error("日期范围过早，请选择接口支持的日期。");
  const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  return { start, end, days, previousStart: shiftDate(start, -days), previousEnd: shiftDate(start, -1),
    granularity: days <= 30 ? "day" as const : days <= 180 ? "week" as const : "month" as const };
}
export function bucketRanges(start: string, end: string, granularity: "day" | "week" | "month") {
  const buckets: { start: string; end: string; partial: boolean }[] = [];
  let cursor = start;
  while (cursor <= end) {
    const date = new Date(cursor + "T00:00:00Z");
    const fullStart = granularity === "month" ? cursor.slice(0, 7) + "-01" : granularity === "week" ? shiftDate(cursor, -((date.getUTCDay() + 6) % 7)) : cursor;
    const fullEnd = granularity === "month" ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
      : granularity === "week" ? shiftDate(fullStart, 6) : cursor;
    const last = fullEnd > end ? end : fullEnd;
    buckets.push({ start: cursor, end: last, partial: cursor !== fullStart || last !== fullEnd });
    cursor = shiftDate(last, 1);
  }
  return buckets;
}
