import { z } from "zod";

// 草稿允许未填写；确认保存时再要求名称、规则和专题所属账号。
export const configurationDraftSchema = z.object({
  name: z.string().trim().max(100),
  content: z.string().max(20000),
});
export const articleSelectionSchema = z.object({
  accountId: z.string().uuid().nullable().default(null),
  topicId: z.string().uuid().nullable().default(null),
});
export const newConfigurationSessionSchema = z.object({
  kind: z.enum(["account", "topic"]),
  accountId: z.string().uuid().nullable().default(null),
  targetId: z.string().uuid().nullable().default(null),
  sourceArticleIds: z.array(z.string().uuid()).max(20).default([]),
});
export const configurationEditSchema = z.object({
  draft: configurationDraftSchema,
  accountId: z.string().uuid().nullable(),
});
export const configurationActionSchema = z.discriminatedUnion("action", [
  configurationEditSchema.extend({ action: z.literal("message"), instruction: z.string().trim().min(1).max(20000) }),
  configurationEditSchema.extend({ action: z.literal("confirm") }),
]);
