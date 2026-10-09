import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const signature = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("base64url");

// 纯函数独立于 Next Cookie，便于验证会话过期、篡改和时序安全密码比较。
export function passwordMatches(expectedPassword: string, value: string) {
  const expected = Buffer.from(expectedPassword), actual = Buffer.from(value);
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createSessionValue(secret: string, now = Date.now()) {
  const issuedAt = String(now);
  return `${issuedAt}.${signature(secret, issuedAt)}`;
}
export function verifySessionValue(secret: string, value: string | undefined, now = Date.now()) {
  if (!secret || !value) return false;
  const [issuedAt, providedSignature] = value.split(".");
  if (!issuedAt || !providedSignature || !/^\d+$/.test(issuedAt)) return false;
  const age = now - Number(issuedAt);
  if (age < 0 || age > SESSION_TTL_MS) return false;
  const expected = Buffer.from(signature(secret, issuedAt)), actual = Buffer.from(providedSignature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
