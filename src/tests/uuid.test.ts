import assert from "node:assert/strict";
import test from "node:test";
import { createUuid } from "../lib/uuid";

test("UUID 兼容生成器在缺少 randomUUID 时仍返回 v4 格式", () => {
  const cryptoApi = globalThis.crypto, original = cryptoApi.randomUUID;
  Object.defineProperty(cryptoApi, "randomUUID", { configurable: true, value: undefined });
  try {
    assert.match(createUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  } finally { Object.defineProperty(cryptoApi, "randomUUID", { configurable: true, value: original }); }
});
