import { z } from "zod";
import { themeNames } from "../../../../lib/we-article/layout-themes";
import { formatArticle } from "../../../../lib/we-article/format";

const inputSchema = z.object({ title: z.string().max(200), body: z.string().max(200000), theme: z.enum(Object.keys(themeNames) as [keyof typeof themeNames, ...(keyof typeof themeNames)[]]) });

// 预览只处理当前编辑快照，不保存或改写文章。
export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    return Response.json(formatArticle(input.body, input.title, input.theme));
  } catch {
    return Response.json({ error: "无法生成排版，请检查正文后重试。" }, { status: 400 });
  }
}
