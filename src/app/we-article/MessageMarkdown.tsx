"use client";

import { createElement, Fragment, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

type Node = { type: string; value?: string; depth?: number; ordered?: boolean; start?: number | null;
  url?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };

// 只创建已知的 React 元素；HTML 和未知节点按 Markdown 原文显示。
export default function MessageMarkdown({ content }: { content: string }) {
  const root = fromMarkdown(content, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] }) as Node;
  function render(node: Node, key: number): ReactNode {
    const children = () => node.children?.map(render);
    const raw = () => content.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
    switch (node.type) {
      case "text": return node.value;
      case "paragraph": return <p key={key}>{children()}</p>;
      case "heading": return createElement(`h${node.depth}`, { key }, children());
      case "strong": return <strong key={key}>{children()}</strong>;
      case "emphasis": return <em key={key}>{children()}</em>;
      case "blockquote": return <blockquote key={key}>{children()}</blockquote>;
      case "list": return node.ordered ? <ol key={key} start={node.start ?? 1}>{children()}</ol> : <ul key={key}>{children()}</ul>;
      case "listItem": return <li key={key}>{children()}</li>;
      case "break": return <br key={key} />;
      case "thematicBreak": return <hr key={key} />;
      case "inlineCode": return <code key={key}>{node.value}</code>;
      case "code": return <pre key={key}><code>{node.value}</code></pre>;
      case "link": return /^https?:\/\//i.test(node.url ?? "")
        ? <a key={key} href={node.url} target="_blank" rel="noreferrer">{children()}</a> : <Fragment key={key}>{raw()}</Fragment>;
      case "table": return <div key={key} className="message-table"><table><tbody>{children()}</tbody></table></div>;
      case "tableRow": return <tr key={key}>{children()}</tr>;
      case "tableCell": return <td key={key}>{children()}</td>;
      default: return <Fragment key={key}>{raw()}</Fragment>;
    }
  }
  return <>{root.children?.map(render)}</>;
}
