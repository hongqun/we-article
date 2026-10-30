import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

import type { LayoutTheme } from "./layout-themes";
// 标题、列表、代码和提示词共享一组颜色，保证同一风格的视觉协调。
const palettes = {
  ink: { accent: "#343434", note: "#92592d", soft: "#f5f5f5", border: "#d5d5d5", heading: "line" },
  green: { accent: "#286653", note: "#947032", soft: "#f1f6f3", border: "#a4c6b7", heading: "bar" },
  blue: { accent: "#315f8e", note: "#896333", soft: "#f2f5f8", border: "#b0c4d8", heading: "line" },
  amber: { accent: "#8a5b24", note: "#8a5b24", soft: "#faf5ec", border: "#d9bd94", heading: "bar" },
  plum: { accent: "#78536f", note: "#835b51", soft: "#f8f2f6", border: "#d2b9ca", heading: "line" },
  slate: { accent: "#465e69", note: "#795e49", soft: "#f0f4f5", border: "#aec0c6", heading: "bar" },
} as const;
type Node = { type: string; value?: string; depth?: number; ordered?: boolean; start?: number | null;
  url?: string; identifier?: string; align?: string | null | Array<string | null>; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
export const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const plain = (node: Node): string => node.value ?? (node.children ?? []).map(plain).join("");
// 公众号富文本可能丢弃 pre 的空白样式，用显式 br 保住代码的原始换行。
const codeHtml = (value: string) => escapeHtml(value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");

// 只按 Markdown 已有结构排版；未知节点保留原文，不让模型增删内容。
export function formatArticle(markdown: string, title: string, theme: LayoutTheme = "ink") {
  if (!(theme in palettes)) throw new Error("未知排版样式。");
  if (!markdown.trim()) throw new Error("正文为空，无法排版。");
  // 启用 GFM 表格扩展，否则 Markdown 表格会被当作普通文本，公众号最终 HTML 无法生成真正的表格。
  const root = fromMarkdown(markdown, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }) as Node;
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
  function render(node: Node, inPrompt = false, inList = false): string {
    const children = () => (node.children ?? []).map(child => render(child, inPrompt, inList)).join("");
    switch (node.type) {
      case "text": return text(node.value ?? "", node);
      // 公众号结构检测会把无单位行高误判为像素值；多行文字统一输出明确的像素行高。
      case "paragraph": return `<p style="margin:0 0 ${inList ? 4 : inPrompt ? 12 : 20}px;line-height:${inPrompt ? 26 : 30}px;">${children()}</p>`;
      case "heading": {
        const decoration = node.depth === 2 ? color.heading === "bar"
          ? `border-left:4px solid ${color.accent};padding-left:12px;`
          : `border-bottom:1px solid ${color.border};padding-bottom:8px;` : "";
        return `<h${node.depth} style="font-size:${node.depth === 1 ? 24 : node.depth === 2 ? 21 : 18}px;font-weight:600;line-height:${node.depth === 1 ? 36 : node.depth === 2 ? 32 : 27}px;margin:30px 0 16px;color:${color.accent};${decoration}">${children()}</h${node.depth}>`;
      }
      // 重点词使用当前风格的强调色，提示词区同样保持可辨认。
      case "strong": return `<strong style="font-weight:600;color:${color.accent};">${children()}</strong>`;
      case "emphasis": return `<em>${children()}</em>`;
      case "break": return "<br>";
      case "thematicBreak": return '<hr style="border:0;border-top:1px solid #dddddd;margin:26px 0;">';
      case "blockquote": return `<blockquote style="margin:20px 0;padding:12px 14px;border-left:3px solid ${color.accent};background-color:${color.soft};color:#555555;">${children()}</blockquote>`;
      case "list": { const tag = node.ordered ? "ol" : "ul"; return `<${tag}${node.ordered ? ` start="${node.start ?? 1}"` : ""} style="padding-left:26px;margin:12px 0 20px;color:${color.accent};">${children()}</${tag}>`; }
      case "listItem": return `<li style="margin:8px 0;line-height:${inPrompt ? 26 : 30}px;color:${inPrompt ? "#666666" : "#333333"};">${(node.children ?? []).map(child => render(child, inPrompt, true)).join("")}</li>`;
      case "table": {
        const rows = node.children ?? [], header = rows[0], bodyRows = rows.slice(1);
        const alignments = Array.isArray(node.align) ? node.align : [];
        const cell = (item: Node, tag: "th" | "td", alignment?: string | null) => `<${tag} style="padding:6px 8px;border:1px solid ${color.border};vertical-align:top;text-align:${alignment ?? "left"};">${(item.children ?? []).map(child => render(child, inPrompt)).join("")}</${tag}>`;
        const row = (item: Node, tag: "th" | "td") => `<tr>${(item.children ?? []).map((child, index) => cell(child, tag, alignments[index])).join("")}</tr>`;
        // 使用内联样式和滚动外框，兼容公众号编辑器对 class/style 标签的清洗规则。
        return `<section style="margin:18px 0;overflow-x:auto;max-width:100%;"><table style="width:100%;min-width:480px;border-collapse:collapse;font-size:13px;line-height:20px;color:#333333;"><thead style="background-color:${color.soft};">${header ? row(header, "th") : ""}</thead><tbody>${bodyRows.map(item => row(item, "td")).join("")}</tbody></table></section>`;
      }
      case "inlineCode": return `<code style="background-color:${color.soft};color:${color.accent};padding:2px 4px;">${escapeHtml(node.value ?? "")}</code>`;
      // 代码区使用对应主题的浅底与边框，保留源码和换行。
      case "code": return `<section style="margin:22px 0;border:1px solid ${color.border};border-radius:6px;overflow:hidden;background-color:${color.soft};"><pre style="white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;margin:0;font-size:14px;font-weight:400;line-height:24px;color:#333333;"><code>${codeHtml(node.value ?? "")}</code></pre></section>`;
      case "link": case "linkReference": {
        const url = node.url ?? definitions.get(node.identifier) ?? "";
        return /^https?:\/\//i.test(url) ? `<a href="${escapeHtml(url)}" style="color:${color.accent};text-decoration:underline;">${children()}</a>` : children();
      }
      case "image": case "imageReference": case "html": return escapeHtml(raw(node));
      case "definition": return "";
      default: return node.children ? children() : escapeHtml(raw(node));
    }
  }
  // 正文标题由用户保留在 Markdown 中，页面标题单独显示。
  const nodes = root.children ?? [];
  const blocks: string[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    blocks.push(render(node));
    // 提示词标题后的正文单独分组，遇到下一标题恢复普通排版。
    if (node.type === "heading" && /提示词/.test(plain(node))) {
      const prompt: Node[] = [];
      while (index + 1 < nodes.length && nodes[index + 1].type !== "heading") prompt.push(nodes[++index]);
      if (prompt.length) blocks.push(`<section style="margin:12px 0 24px;padding:14px 16px;border:1px solid ${color.border};background-color:${color.soft};font-size:14px;line-height:26px;color:#666666;">${prompt.map(item => render(item, true)).join("")}</section>`);
    }
  }
  const body = blocks.join("");
  const html = `<section style="font-size:16px;font-weight:300;line-height:30px;color:#333333;text-align:left;overflow-wrap:break-word;">${body}</section>`;
  return { title: title.trim() || "未命名文章", html };
}
