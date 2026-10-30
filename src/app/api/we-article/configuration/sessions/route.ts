import { writingStore } from "../../../../../lib/we-article/store";
import { errorResponse } from "../../../../../lib/we-article/http";
import { newConfigurationSessionSchema } from "../../../../../lib/we-article/configuration-schema";
import { ArticleError } from "../../../../../lib/we-article/validation";

export const runtime = "nodejs";
// 提炼保留文章正文快照，后续编辑来源文章不会丢失当时的依据。
export async function POST(request: Request) {
  try {
    const input = newConfigurationSessionSchema.parse(await request.json());
    const store = writingStore();
    const sources = [...new Set(input.sourceArticleIds)].map(id => {
      const article = store.read(id);
      if (!article.body.trim()) throw new ArticleError(`“${article.title}”还没有正文，不能用于提炼。`, 400);
      return { id, title: article.title, body: article.body };
    });
    if (sources.reduce((sum, source) => sum + source.body.length, 0) > 200000)
      throw new ArticleError("所选文章内容过长，请减少选择。", 400);
    return Response.json(store.configuration.createSession(input, sources), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
