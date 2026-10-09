import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import { topicIdSchema } from "../topics";

const schema = z.object({ AppID: z.string().trim().min(1), AppSecret: z.string().trim().min(1),
  defaultThumbMediaId: z.string().trim().optional(), author: z.string().trim().max(16).optional(),
  needOpenComment: z.boolean().default(true), onlyFansCanComment: z.boolean().default(false) });
export type PublishConfig = z.infer<typeof schema>;

async function settings() {
  try { return parse(await readFile(path.resolve(process.cwd(), ".env"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
function envBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || !value.trim()) return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error("公众号布尔配置仅支持 true 或 false。");
}

// 凭据和账号级发布设置只从被忽略的项目 .env 读取，不进入专题文件或前端响应。
export function parsePublishSettings(topicId: string, values: Record<string, string | undefined>): PublishConfig | null {
  topicIdSchema.parse(topicId);
  const prefix = `WECHAT_${topicId.replace(/-/g, "_").toUpperCase()}_`;
  const appId = values[`${prefix}APP_ID`]?.trim();
  const appSecret = values[`${prefix}APP_SECRET`]?.trim();
  if (!appId && !appSecret) return null;
  const parsed = schema.safeParse({
    AppID: appId,
    AppSecret: appSecret,
    defaultThumbMediaId: values[`${prefix}DEFAULT_THUMB_MEDIA_ID`],
    author: values[`${prefix}AUTHOR`],
    needOpenComment: envBoolean(values[`${prefix}NEED_OPEN_COMMENT`], true),
    onlyFansCanComment: envBoolean(values[`${prefix}ONLY_FANS_CAN_COMMENT`], false),
  });
  if (!parsed.success) throw new Error("公众号配置无效，请检查 .env 中对应专题的 WECHAT_*_APP_ID 和 WECHAT_*_APP_SECRET。");
  return parsed.data;
}
export async function publishConfig(topicId: string): Promise<PublishConfig | null> {
  return parsePublishSettings(topicId, await settings());
}
export async function publishSummary(topicId: string) {
  try {
    const config = await publishConfig(topicId);
    return { enabled: Boolean(config), coverConfigured: Boolean(config?.defaultThumbMediaId) };
  } catch { return { enabled: true, coverConfigured: false, error: "公众号配置无效，请检查本地 .env。" }; }
}
export async function publishAccounts() {
  const root = path.join(process.cwd(), "topics");
  const local = path.join(process.cwd(), "data", "local", "topics");
  const ids = new Set<string>();
  for (const directory of [root, local]) {
    try { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name); }
    catch { /* local topic directory is optional */ }
  }
  const accounts = new Map<string, PublishConfig>();
  for (const id of ids) {
    try { const config = await publishConfig(id); if (config) accounts.set(config.AppID, config); }
    catch { /* one misconfigured account must not block others */ }
  }
  return [...accounts.values()];
}
