import { ZodError } from "zod";
import { ArticleError } from "./validation";

// 服务端详细异常留在服务端，响应不暴露模型请求头或配置内容。
export function errorResponse(error: unknown) {
  if (error instanceof ArticleError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError)
    return Response.json({ error: "请求内容无效，请检查输入。" }, { status: 400 });
  return Response.json({ error: "操作失败，请稍后重试。" }, { status: 500 });
}
