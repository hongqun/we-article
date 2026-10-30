import { writingStore } from "../../../../lib/we-article/store";
import { errorResponse } from "../../../../lib/we-article/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 配置入口沿用独立工作区的访问方式，不读取旧专题目录。
export async function GET() {
  try { return Response.json(writingStore().configuration.list(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
