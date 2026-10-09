import assert from "node:assert/strict";
import test from "node:test";
import { createSessionValue, passwordMatches, SESSION_TTL_MS, verifySessionValue } from "../lib/auth-crypto";

test("认证密码只接受完整匹配", () => {
  assert.equal(passwordMatches("correct horse", "correct horse"), true);
  assert.equal(passwordMatches("correct horse", "correct"), false);
  assert.equal(passwordMatches("", ""), false);
});

test("会话拒绝篡改、未来与过期值", () => {
  const now = 1_700_000_000_000, session = createSessionValue("secret", now);
  assert.equal(verifySessionValue("secret", session, now + 1), true);
  assert.equal(verifySessionValue("other", session, now + 1), false);
  assert.equal(verifySessionValue("secret", `${session}x`, now + 1), false);
  assert.equal(verifySessionValue("secret", session, now + SESSION_TTL_MS + 1), false);
  assert.equal(verifySessionValue("secret", createSessionValue("secret", now + 1), now), false);
});
