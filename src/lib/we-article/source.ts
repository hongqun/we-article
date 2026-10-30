import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { load } from "cheerio";

// 限制访问公开地址，并将连接固定到已检查的 DNS 结果。
function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  return isIP(address) === 6 && /^[23]/i.test(address);
}

async function fetchPage(url: URL, signal: AbortSignal, redirects = 0): Promise<string> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("仅支持公开的 HTTP/HTTPS 网页。");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error("只能读取公开网页。");
  const address = addresses[0];
  const result = await new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { signal, lookup: (_host, _options, callback) => callback(null, address.address, address.family), headers: { "User-Agent": "We-Article/1.0" } }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2_000_000) { req.destroy(new Error("网页内容过长，请粘贴需要解读的段落。")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode || 0, location: response.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.setTimeout(20000, () => req.destroy(new Error("网页读取超时，请粘贴原文。")));
    req.on("error", reject);
    req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location && redirects < 3)
    return fetchPage(new URL(result.location, url), signal, redirects + 1);
  if (result.status < 200 || result.status >= 300) throw new Error(`网页读取失败（HTTP ${result.status}），请粘贴原文。`);
  return result.body;
}

export async function readWebSource(address: string, signal: AbortSignal) {
  const url = new URL(address);
  const html = await fetchPage(url, signal);
  const $ = load(html);
  $("script, style, nav, footer, noscript, header").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body").first();
  root.find("p, h1, h2, h3, h4, h5, h6, li, br").after("\n");
  const content = root.text().replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!content) throw new Error("网页没有可读取的正文，请粘贴原文。");
  if (content.length > 100000) throw new Error("网页内容过长，请粘贴需要解读的段落。");
  return { url: url.href, content, createdAt: new Date().toISOString() };
}
