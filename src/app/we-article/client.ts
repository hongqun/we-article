// 页面请求统一使用独立文章接口。
export const api = "/api/we-article/articles";
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请重试。");
  return data as T;
}
