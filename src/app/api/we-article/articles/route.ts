import { writingStore } from "../../../../lib/we-article/store";
import { errorResponse } from "../../../../lib/we-article/http";

// 新入口无需会话，接口只访问独立文章库。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(writingStore().list(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST() {
  try { return Response.json(writingStore().create(), { status: 201 }); }
  catch (error) { return errorResponse(error); }
}
