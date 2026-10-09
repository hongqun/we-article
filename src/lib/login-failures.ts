import { appendFile, chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

const file = path.join(process.cwd(), "data", "login-failures.jsonl");
const rotatedFile = `${file}.1`;
const maxBytes = 5 * 1024 * 1024;
const maxRecords = 200;
export type LoginFailure = { timestamp: string; ip: string; userAgent: string; reason: string };

const truncate = (value: string, length: number) => value.slice(0, length);
const requestIp = (request: Request) => truncate(request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown", 128);

// 失败记录独立于 SQLite 业务资产，限制权限并按大小轮转，避免无限增长。
export async function recordLoginFailure(request: Request, reason: string) {
  await mkdir(path.dirname(file), { recursive: true });
  try { if ((await stat(file)).size >= maxBytes) await rename(file, rotatedFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const record: LoginFailure = { timestamp: new Date().toISOString(), ip: requestIp(request), userAgent: truncate(request.headers.get("user-agent") ?? "unknown", 512), reason: truncate(reason, 160) };
  await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readLoginFailures(): Promise<LoginFailure[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).slice(-maxRecords).reverse().flatMap(line => {
      try {
        const value = JSON.parse(line) as Partial<LoginFailure>;
        return typeof value.timestamp === "string" && typeof value.ip === "string" && typeof value.userAgent === "string" && typeof value.reason === "string" ? [value as LoginFailure] : [];
      } catch { return []; }
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
