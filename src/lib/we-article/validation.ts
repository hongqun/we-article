import { z } from "zod";

// 限制正文与输入长度，避免意外把整份文件交给模型或数据库。
export const articleId = z.string().uuid();
export const draftSchema = z.object({
  title: z.string().trim().max(200),
  body: z.string().max(200000),
});
export const chatSchema = z.object({
  instruction: z.string().trim().min(1, "请输入材料或要求。").max(50000),
});
// 助手回复以原始 Markdown 保存，允许用户清空内容。
export const messageSchema = z.object({ content: z.string().max(200000) });
export class ArticleError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
