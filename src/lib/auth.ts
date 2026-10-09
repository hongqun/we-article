import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSessionValue, passwordMatches as passwordsEqual, SESSION_TTL_MS, verifySessionValue } from "./auth-crypto";

export const SESSION_COOKIE = "article-session";

// 认证同样只读取 .env，不能意外继承视频工作台或启动终端的同名变量。
async function authSettings() {
  try { return parse(await readFile(path.resolve(process.cwd(), ".env"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function isAuthConfigured() {
  const settings = await authSettings();
  return Boolean(settings.APP_PASSWORD?.trim() && settings.SESSION_SECRET?.trim());
}

async function secret() { return (await authSettings()).SESSION_SECRET?.trim() ?? ""; }
async function password() { return (await authSettings()).APP_PASSWORD ?? ""; }

export async function passwordMatches(value: string) {
  return passwordsEqual(await password(), value);
}

export async function createSession() {
  return createSessionValue(await secret());
}

export async function verifySession(value: string | undefined) {
  if (!value || !await isAuthConfigured()) return false;
  return verifySessionValue(await secret(), value);
}

export async function sessionCookieOptions() {
  const settings = await authSettings();
  return { httpOnly: true, sameSite: "lax" as const, secure: settings.AUTH_COOKIE_SECURE === "true", path: "/", maxAge: SESSION_TTL_MS / 1000 };
}

export async function requireAuth() {
  const store = await cookies();
  if (await verifySession(store.get(SESSION_COOKIE)?.value)) return null;
  return NextResponse.json({ error: "请先登录" }, { status: 401 });
}
