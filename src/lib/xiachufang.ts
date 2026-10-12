import { load } from "cheerio";

export type XiachufangSearchHit = { name: string; url: string };
export type XiachufangRecipe = { name: string; ingredients: string[]; steps: string[]; url: string };

const site = "https://www.xiachufang.com";
const recipePath = /^\/recipe\/\d+\/?$/;
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; We-Article/1.0)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`下厨房页面读取失败：HTTP ${response.status}。请粘贴具体菜谱内容。`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("下厨房页面过长，请粘贴具体菜谱内容。");
  return html;
}

export function parseXiachufangSearch(html: string): XiachufangSearchHit[] {
  const $ = load(html);
  const found: XiachufangSearchHit[] = [];
  const seen = new Set<string>();
  // 只取搜索结果正文中的单篇菜谱，排除导航、推荐和分类链接。
  $(".search-result-list .normal-recipe-list .recipe .name a[href]").each((_, element) => {
    const pathname = $(element).attr("href") ?? "";
    const name = normalize($(element).text());
    if (!recipePath.test(pathname) || !name || seen.has(pathname)) return;
    seen.add(pathname);
    found.push({ name, url: new URL(pathname, site).href });
  });
  return found.slice(0, 8);
}

export function parseXiachufangRecipe(html: string, url: string): XiachufangRecipe {
  const pathname = new URL(url).pathname;
  if (!recipePath.test(pathname)) throw new Error("请提供下厨房单篇菜谱链接，而非搜索页或合集页。");
  const $ = load(html);
  const name = normalize($("h1").first().text());
  const ingredients: string[] = [];
  $(".ings tr").each((_, row) => {
    const parts = $(row).find("td").map((__, cell) => normalize($(cell).text())).get().filter(Boolean);
    if (parts.length) ingredients.push(parts.join(" "));
  });
  const steps = $(".steps .text").map((_, element) => normalize($(element).text())).get().filter(Boolean);
  if (!name || ingredients.length < 2 || steps.length < 2)
    throw new Error("该页面未提供完整的单道菜食材与步骤，请换一篇菜谱或粘贴内容。");
  return { name, ingredients, steps, url: new URL(pathname, site).href };
}

export async function searchXiachufang(keyword: string): Promise<XiachufangSearchHit[]> {
  const query = normalize(keyword);
  if (!query || query.length > 40) throw new Error("请用不超过 40 字的具体菜名搜索。");
  const url = `${site}/search/?keyword=${encodeURIComponent(query)}`;
  const hits = parseXiachufangSearch(await fetchHtml(url));
  if (!hits.length) throw new Error("下厨房没有返回可读取的单篇菜谱，请粘贴具体做法。");
  return hits;
}

export async function readXiachufangRecipe(url: string): Promise<XiachufangRecipe> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("菜谱链接无效。"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.xiachufang.com" || !recipePath.test(parsed.pathname))
    throw new Error("只能读取下厨房的单篇 HTTPS 菜谱链接。");
  return parseXiachufangRecipe(await fetchHtml(parsed.href), parsed.href);
}

export function formatXiachufangRecipe(recipe: XiachufangRecipe): string {
  return `菜名：${recipe.name}\n食材：\n${recipe.ingredients.map(item => `- ${item}`).join("\n")}\n步骤：\n${recipe.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
}
