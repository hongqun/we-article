import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { load } from "cheerio";

// 明确区分读取阶段，避免将失败原因交给模型猜测。
export class SourceError extends Error {}

async function fetchPage(url: URL, signal: AbortSignal, redirects = 0): Promise<string> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SourceError("链接不是可读取的 HTTP/HTTPS 公开网页。");
  const result = await new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { signal, headers: { "User-Agent": "We-Article/1.0" } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2_000_000) { req.destroy(new SourceError("网页内容过长，请粘贴需要解读的段落。")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.setTimeout(20000, () => req.destroy(new SourceError("连接网页超时。")));
    req.on("error", reject);
    req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location && redirects < 3)
    return fetchPage(new URL(result.location, url), signal, redirects + 1);
  if (result.status < 200 || result.status >= 300) throw new SourceError(`网页返回 HTTP ${result.status}，未能读取正文。`);
  return result.body;
}

export async function readWebSource(address: string, signal: AbortSignal) {
  const url = new URL(address);
  let html: string;
  try { html = await fetchPage(url, signal); }
  catch (error) {
    if (error instanceof SourceError) throw error;
    if (signal.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new SourceError("域名解析失败，运行环境无法解析该网页域名。");
    throw new SourceError("连接网页失败，请检查运行环境的网络连接。");
  }
  const $ = load(html);
  $("script, style, nav, footer, noscript, header").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body").first();
  root.find("p, h1, h2, h3, h4, h5, h6, li, br").after("\n");
  const content = root.text().replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!content) throw new SourceError("网页返回的 HTML 中没有提取到正文。");
  if (content.length > 100000) throw new SourceError("网页内容过长，请粘贴需要解读的段落。");
  return { url: url.href, content, createdAt: new Date().toISOString() };
}
