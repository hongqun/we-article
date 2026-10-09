import { randomUUID } from "node:crypto";
import { wechatCall, WechatError } from "./client";
import { publishAccounts, type PublishConfig } from "./config";
import { beijingToday, datesBetween, FIRST_DATE, shiftDate, sources, type DataSource } from "./dates";
import { wechatStore, type WechatStore, type FetchRow } from "./store";

type DataItem = { ref_date?: string; msgid?: string; title?: string; content_url?: string;
  detail?: Record<string, unknown>; detail_list?: (Record<string, unknown> & { stat_date: string })[] };
export type DataResponse = { list: DataItem[]; is_delay: boolean | string };
// 完成记录和原始响应一并落盘；空响应与未获取有不同状态，累计快照不写入日增量表。
export function persistResponse(store: WechatStore, account: string, source: DataSource, date: string, response: DataResponse) {
  if (!Array.isArray(response.list) || ![true, false, "true", "false"].includes(response.is_delay)) throw new Error("统计响应缺少有效列表或延迟标记。");
  const delayed = response.is_delay === true || response.is_delay === "true", now = new Date().toISOString();
  store.db.transaction(() => {
    store.db.prepare(`INSERT INTO wx_raw VALUES(?,?,?,?,?) ON CONFLICT(account,source,date) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at`)
      .run(account, source, date, JSON.stringify(response), now);
    if (source !== "getarticletotaldetail") {
      store.db.prepare("DELETE FROM wx_daily WHERE account=? AND source=? AND date=?").run(account, source, date);
      const insert = store.db.prepare("INSERT INTO wx_daily VALUES(?,?,?,?,?)");
      for (const item of response.list) {
        if (item.ref_date && item.ref_date !== date) throw new Error("统计响应日期与请求不一致。");
        if (!item.detail || (source !== "getbizsummary" && !item.msgid)) throw new Error("统计响应缺少文章标识或指标。");
        insert.run(account, source === "getbizsummary" ? "" : item.msgid, date, source, JSON.stringify(item.detail));
      }
    } else {
      for (const item of response.list) {
        if (!item.msgid || !Array.isArray(item.detail_list)) throw new Error("文章累计响应缺少标识或快照。");
        store.db.prepare(`INSERT INTO wx_articles VALUES(?,?,?,?,?) ON CONFLICT(account,msgid) DO UPDATE SET
          title=excluded.title,url=excluded.url,published_at=excluded.published_at`).run(account, item.msgid, item.title ?? item.msgid, item.content_url ?? "", item.ref_date ?? date);
        for (const detail of item.detail_list) store.db.prepare(`INSERT INTO wx_totals VALUES(?,?,?,?) ON CONFLICT(account,msgid,stat_date)
          DO UPDATE SET payload=excluded.payload`).run(account, item.msgid, detail.stat_date, JSON.stringify(detail));
      }
    }
    store.db.prepare("UPDATE wx_fetches SET state=?,fetched_at=?,error=NULL,retry_at=?,attempts=0 WHERE account=? AND source=? AND date=?")
      .run(delayed ? "delayed" : "complete", now, delayed ? new Date(Date.now() + 3600000).toISOString() : "", account, source, date);
  })();
}
export function enqueueHistory(store: WechatStore, account: string, manual = false, now = new Date()) {
  const today = beijingToday(now), end = shiftDate(today, -1), timestamp = now.toISOString();
  const meta = store.db.prepare("SELECT scheduled_day FROM wx_sync WHERE account=?").get(account) as { scheduled_day: string } | undefined;
  const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
  const refresh = manual || (hour >= 9 && meta?.scheduled_day !== today);
  store.db.transaction(() => {
    store.db.prepare("INSERT OR IGNORE INTO wx_sync(account) VALUES(?)").run(account);
    // 先建完整待办，再以日期倒序处理：最近 180 天自然优先，之后继续向历史推进。
    const insert = store.db.prepare("INSERT OR IGNORE INTO wx_fetches(account,source,date,state) VALUES(?,?,?,'pending')");
    const latest = store.db.prepare("SELECT MAX(date) AS date FROM wx_fetches WHERE account=?").get(account) as { date: string | null };
    // 首次一次性登记历史；后续只登记新增日期，不每分钟扫描写入整段历史。
    for (const date of datesBetween(latest.date ?? FIRST_DATE, end)) for (const source of sources) insert.run(account, source, date);
    // 定时补入的新日期沿用已知权限结论，避免每天重新请求同一个无权限接口。
    store.db.prepare(`UPDATE wx_fetches SET state='unavailable',error=(SELECT error FROM wx_source_status WHERE account=wx_fetches.account AND source=wx_fetches.source),retry_at=''
      WHERE account=? AND state='pending' AND EXISTS (SELECT 1 FROM wx_source_status WHERE account=wx_fetches.account AND source=wx_fetches.source AND state='unavailable')`)
      .run(account);
    if (refresh) {
      store.db.prepare(`UPDATE wx_fetches SET state='pending',retry_at='',error=NULL,attempts=0 WHERE account=? AND
        ((source='getarticletotaldetail' AND date>=?) OR (source<>'getarticletotaldetail' AND date>=?) OR state IN ('failed','delayed'))`)
        .run(account, shiftDate(today, -30), shiftDate(today, -7));
      store.db.prepare("UPDATE wx_sync SET scheduled_day=?,last_started=?,error=NULL WHERE account=?").run(today, timestamp, account);
    }
  })();
}
const globalSync = globalThis as typeof globalThis & { wxSyncRunning?: boolean; wxSyncTimer?: ReturnType<typeof setInterval> };
export async function processAccount(config: PublishConfig, store = wechatStore(), call: typeof wechatCall = wechatCall) {
  const owner = randomUUID(), lease = `sync:${config.AppID}`;
  if (!store.lease(lease, owner)) return;
  try {
    // 每轮限量并释放数据库锁；网络等待期间不持有 SQLite 写事务。
    for (let index = 0; index < 12; index++) {
      if (!store.lease(lease, owner)) return;
      const row = store.db.prepare(`SELECT * FROM wx_fetches WHERE account=? AND state NOT IN ('complete','unavailable') AND retry_at<=?
        ORDER BY date DESC,source LIMIT 1`).get(config.AppID, new Date().toISOString()) as FetchRow | undefined;
      if (!row) {
        const remaining = store.db.prepare("SELECT COUNT(*) AS n FROM wx_fetches WHERE account=? AND state NOT IN ('complete','unavailable')").get(config.AppID) as { n: number };
        if (!remaining.n) store.db.prepare("UPDATE wx_sync SET last_finished=? WHERE account=?").run(new Date().toISOString(), config.AppID);
        break;
      }
      try {
        const result = await call<DataResponse>(config, `/datacube/${row.source}`, { begin_date: row.date, end_date: row.date });
        persistResponse(store, config.AppID, row.source as DataSource, row.date, result);
        // 手动刷新重新探测成功后，删除旧的接口无权限提示。
        store.db.prepare("DELETE FROM wx_source_status WHERE account=? AND source=?").run(config.AppID, row.source);
        store.db.prepare("UPDATE wx_sync SET error=NULL WHERE account=?").run(config.AppID);
      } catch (error) {
        const message = error instanceof Error ? error.message : "同步失败";
        if (error instanceof WechatError && error.code === 48001) {
          // 权限按接口而非整账号处理，避免一个缺权接口阻塞可用指标。
          const now = new Date().toISOString();
          store.db.transaction(() => {
            store.db.prepare(`INSERT INTO wx_source_status(account,source,state,error,updated_at) VALUES(?,?, 'unavailable',?,?)
              ON CONFLICT(account,source) DO UPDATE SET state=excluded.state,error=excluded.error,updated_at=excluded.updated_at`)
              .run(config.AppID, row.source, message, now);
            store.db.prepare("UPDATE wx_fetches SET state='unavailable',error=?,retry_at='' WHERE account=? AND source=? AND state<>'complete'")
              .run(message, config.AppID, row.source);
          })();
          continue;
        }
        const blocked = error instanceof WechatError && [40001, 40013, 40125, 40164, 48001, 48004, 45009].includes(error.code ?? 0);
        const retry = new Date(Date.now() + (blocked ? 6 * 3600000 : Math.min(3600000, 60000 * 2 ** Math.min(row.attempts, 6)))).toISOString();
        store.db.prepare("UPDATE wx_fetches SET state='failed',error=?,retry_at=?,attempts=attempts+1 WHERE account=? AND source=? AND date=?")
          .run(message, retry, config.AppID, row.source, row.date);
        store.db.prepare("UPDATE wx_sync SET error=? WHERE account=?").run(message, config.AppID);
        if (blocked) {
          store.db.prepare("UPDATE wx_fetches SET retry_at=? WHERE account=? AND state<>'complete'").run(retry, config.AppID);
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  } finally { store.release(lease, owner); }
}
export async function syncTick() {
  if (globalSync.wxSyncRunning) return;
  globalSync.wxSyncRunning = true;
  try {
    const store = wechatStore();
    for (const config of await publishAccounts()) { enqueueHistory(store, config.AppID); await processAccount(config, store); }
  } finally { globalSync.wxSyncRunning = false; }
}
export function startWechatScheduler() {
  if (globalSync.wxSyncTimer) return;
  const run = () => { void syncTick().catch(() => { /* 账号失败在库内展示；下一次 tick 可恢复全局故障。 */ }); };
  globalSync.wxSyncTimer = setInterval(run, 60_000);
  globalSync.wxSyncTimer.unref(); run();
}
export async function requestSync(config: PublishConfig) {
  const store = wechatStore();
  // 用户手动刷新意味着允许重新探测已标记无权限的接口。
  store.db.prepare("DELETE FROM wx_source_status WHERE account=? AND state='unavailable'").run(config.AppID);
  enqueueHistory(store, config.AppID, true);
  startWechatScheduler();
  void syncTick().catch(() => {});
}
