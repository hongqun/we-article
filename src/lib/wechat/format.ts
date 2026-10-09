import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { createHash } from "node:crypto";

export const themeNames = { ink: "素雅黑", green: "清雅绿", blue: "简洁蓝" } as const;
export type LayoutTheme = keyof typeof themeNames;
// 模板外框按主题配色，独立于代码块边框，保证浅底色上的轮廓清晰。
const palettes = { ink: { accent: "#343434", note: "#92592d", soft: "#f5f5f5", codeBorder: "#e2e6e4", templateBorder: "#929292" },
  green: { accent: "#286653", note: "#947032", soft: "#f1f6f3", codeBorder: "#78a995", templateBorder: "#78a995" },
  blue: { accent: "#315f8e", note: "#896333", soft: "#f2f5f8", codeBorder: "#e2e6e4", templateBorder: "#809fbe" } };
type Node = { type: string; value?: string; depth?: number; ordered?: boolean; start?: number | null;
  url?: string; identifier?: string; align?: string | null | Array<string | null>; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const plain = (node: Node): string => node.value ?? (node.children ?? []).map(plain).join("");
export function contentHash(value: string) { return createHash("sha256").update(value).digest("hex"); }
// 公众号富文本可能丢弃 pre 的空白样式，用显式 br 保住代码的原始换行。
const codeHtml = (value: string) => escapeHtml(value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");

// 只按 Markdown 已有结构排版；未知节点保留原文，不让模型增删内容。
export function formatArticle(markdown: string, fallbackTitle: string, theme: LayoutTheme = "ink", titleOverride?: string) {
  if (!(theme in palettes)) throw new Error("未知排版样式。");
  if (!markdown.trim()) throw new Error("正文为空，无法排版。");
  // 启用 GFM 表格扩展，否则 Markdown 表格会被当作普通文本，公众号最终 HTML 无法生成真正的表格。
  const root = fromMarkdown(markdown, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }) as Node;
  const first = root.children?.[0];
  const heading = first?.type === "heading" && first.depth === 1 ? first : undefined;
  const title = (titleOverride ?? (heading ? plain(heading) : fallbackTitle)).trim();
  if (!title) throw new Error("请先填写文章标题。");
  const color = palettes[theme];
  const raw = (node: Node) => markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
  const definitions = new Map((root.children ?? []).filter(node => node.type === "definition").map(node => [node.identifier, node.url]));
  const noteRanges = [...markdown.matchAll(/[（(]\s*配图要求\s*[:：][\s\S]*?[）)]/g)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  function text(value: string, node: Node) {
    // 配图说明跨越加粗或链接节点时，按原文位置分别着色，仍保留原有内联结构。
    const start = node.position?.start.offset ?? 0, end = node.position?.end.offset ?? start;
    const overlaps = noteRanges.filter(range => range.start < end && range.end > start);
    if (overlaps.length && raw(node) === value) {
      let cursor = 0, result = "";
      for (const range of overlaps) {
        const from = Math.max(0, range.start - start), to = Math.min(value.length, range.end - start);
        result += escapeHtml(value.slice(cursor, from)) + `<span style="color:${color.note};">${escapeHtml(value.slice(from, to))}</span>`;
        cursor = to;
      }
      return result + escapeHtml(value.slice(cursor));
    }
    // 配图要求只着色；中英文括号均支持，跨行要求仍保留全部字符。
    const pattern = /[（(]\s*配图要求\s*[:：][\s\S]*?[）)]/g;
    let offset = 0, html = "";
    for (const match of value.matchAll(pattern)) {
      html += escapeHtml(value.slice(offset, match.index));
      html += `<span style="color:${color.note};">${escapeHtml(match[0])}</span>`;
      offset = match.index! + match[0].length;
    }
    return html + escapeHtml(value.slice(offset));
  }
  function render(node: Node): string {
    const children = () => (node.children ?? []).map(render).join("");
    switch (node.type) {
      case "text": return text(node.value ?? "", node);
      // 公众号结构检测会把无单位行高误判为像素值；多行文字统一输出明确的像素行高。
      case "paragraph": return `<p style="margin:0 0 20px;line-height:30px;">${children()}</p>`;
      case "heading": return `<h${node.depth} style="font-size:${node.depth === 1 ? 24 : node.depth === 2 ? 21 : 18}px;font-weight:500;line-height:${node.depth === 1 ? 36 : node.depth === 2 ? 32 : 27}px;margin:28px 0 14px;color:${color.accent};">${children()}</h${node.depth}>`;
      case "strong": return `<strong style="font-weight:500;">${children()}</strong>`;
      case "emphasis": return `<em>${children()}</em>`;
      case "break": return "<br>";
      case "thematicBreak": return '<hr style="border:0;border-top:1px solid #dddddd;margin:26px 0;">';
      case "blockquote": return `<blockquote style="margin:20px 0;padding:4px 0 4px 16px;border-left:3px solid ${color.accent};color:#555555;">${children()}</blockquote>`;
      case "list": { const tag = node.ordered ? "ol" : "ul"; return `<${tag}${node.ordered ? ` start="${node.start ?? 1}"` : ""} style="padding-left:26px;margin:12px 0 20px;">${children()}</${tag}>`; }
      case "listItem": return `<li style="margin:8px 0;line-height:30px;">${children()}</li>`;
      case "table": {
        const rows = node.children ?? [], header = rows[0], bodyRows = rows.slice(1);
        const alignments = Array.isArray(node.align) ? node.align : [];
        const cell = (item: Node, tag: "th" | "td", alignment?: string | null) => `<${tag} style="padding:6px 8px;border:1px solid ${color.templateBorder};vertical-align:top;text-align:${alignment ?? "left"};">${(item.children ?? []).map(render).join("")}</${tag}>`;
        const row = (item: Node, tag: "th" | "td") => `<tr>${(item.children ?? []).map((child, index) => cell(child, tag, alignments[index])).join("")}</tr>`;
        // 使用内联样式和滚动外框，兼容公众号编辑器对 class/style 标签的清洗规则。
        return `<section style="margin:18px 0;overflow-x:auto;max-width:100%;"><table style="width:100%;min-width:480px;border-collapse:collapse;font-size:13px;line-height:20px;color:#333333;"><thead style="background-color:${color.soft};">${header ? row(header, "th") : ""}</thead><tbody>${bodyRows.map(item => row(item, "td")).join("")}</tbody></table></section>`;
      }
      case "inlineCode": return `<code style="background-color:${color.soft};color:${color.accent};padding:2px 4px;">${escapeHtml(node.value ?? "")}</code>`;
      // 清雅绿用加深的双像素外框；圆点使用真实字符，避免公众号清洗空 span 后消失。
      case "code": return `<section style="margin:22px 0;border:${theme === "green" ? 2 : 1}px solid ${color.codeBorder};border-radius:8px;overflow:hidden;background-color:${color.soft};box-shadow:0 5px 14px rgba(35,45,40,0.06);"><section style="height:30px;line-height:30px;padding:0 12px;border-bottom:1px solid ${color.codeBorder};background-color:#fafbfa;"><span style="display:inline-block;margin-right:6px;color:#d8a4a4;font-size:12px;line-height:12px;vertical-align:middle;">●</span><span style="display:inline-block;margin-right:6px;color:#dccb93;font-size:12px;line-height:12px;vertical-align:middle;">●</span><span style="display:inline-block;color:#9ebfac;font-size:12px;line-height:12px;vertical-align:middle;">●</span></section><pre style="white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;margin:0;background-color:${color.soft};font-size:14px;font-weight:400;line-height:24px;"><code>${codeHtml(node.value ?? "")}</code></pre></section>`;
      case "link": case "linkReference": {
        const url = node.url ?? definitions.get(node.identifier) ?? "";
        return /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" style="color:${color.accent};text-decoration:underline;">${children()}</a>` : children();
      }
      case "image": case "imageReference": case "html": return escapeHtml(raw(node));
      case "definition": return "";
      default: return node.children ? children() : escapeHtml(raw(node));
    }
  }
  const nodes = (root.children ?? []).filter(node => node !== heading);
  // 视觉提示词以加粗字段名和正文成组出现，并非代码块；只在模板章节中识别完整的六组结构。
  const templateLabels = ["画面目标", "构图与视角", "空间布局", "色彩", "光影与材质", "避免"];
  let inTemplate = false;
  const body: string[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.type === "heading") inTemplate = /模板/.test(plain(node));
    const templateNodes = nodes.slice(index, index + templateLabels.length * 2);
    const isTemplate = inTemplate && templateLabels.every((label, offset) => {
      const field = templateNodes[offset * 2], value = templateNodes[offset * 2 + 1];
      return field?.type === "paragraph" && field.children?.length === 1
        && field.children[0].type === "strong" && plain(field).trim() === label
        && value?.type === "paragraph" && !/[（(]\s*配图要求\s*[:：]/.test(plain(value));
    });
    if (isTemplate) {
      // 外框样式随导出 HTML 一起复制；范围只包含模板，保留配图说明和结尾的位置。
      body.push(`<section style="margin:22px 0;padding:16px;border:2px solid ${color.templateBorder};border-radius:8px;background-color:${color.soft};color:#333333;font-size:16px;line-height:30px;">${templateNodes.map(render).join("")}</section>`);
      index += templateNodes.length - 1;
    } else body.push(render(node));
  }
  // 正文保持轻字重，代码区单独恢复正常字重，避免细笔画影响代码辨识。
  const html = `<section style="font-size:16px;font-weight:300;line-height:30px;color:#333333;text-align:left;overflow-wrap:break-word;">${body.join("")}</section>`;
  return { title, html, theme, fingerprint: contentHash(JSON.stringify({ title, html })), markdownHash: contentHash(markdown) };
}
