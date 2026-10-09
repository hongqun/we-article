import type { MemoryEvent } from "../lib/style-memory/types";

type DiffKind = "same" | "added" | "removed";
type DiffPart = { kind: DiffKind; value: string };

// 汉字逐字、英文按词切分，能突出常见措辞替换，同时控制比较矩阵的规模。
function tokens(text: string) { return text.match(/[\u3400-\u9fff]|[A-Za-z0-9_]+|\s+|[^\s]/gu) ?? []; }
function append(parts: DiffPart[], kind: DiffKind, value: string) {
  if (!value) return;
  const last = parts.at(-1);
  if (last?.kind === kind) last.value += value;
  else parts.push({ kind, value });
}
function edgeDiff(before: string, after: string): DiffPart[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end += 1;
  const parts: DiffPart[] = [];
  append(parts, "same", before.slice(0, start));
  append(parts, "removed", before.slice(start, before.length - end));
  append(parts, "added", after.slice(start, after.length - end));
  append(parts, "same", end ? before.slice(-end) : "");
  return parts;
}

// 长文退回到变动边界；一般编辑使用 LCS 保留中间的相同上下文。
function compare(before: string, after: string): DiffPart[] {
  const left = tokens(before); const right = tokens(after);
  if (left.length * right.length > 360000) return edgeDiff(before, after);
  const width = right.length + 1;
  const table = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1)
    table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const parts: DiffPart[] = [];
  let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { append(parts, "same", left[i]); i += 1; j += 1; }
    else if (j === right.length || (i < left.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) { append(parts, "removed", left[i]); i += 1; }
    else { append(parts, "added", right[j]); j += 1; }
  }
  return parts;
}

// 差异组件只负责呈现，概览和编辑页共享同一组增删含义。
export default function ChangeDiff({ before, after }: Pick<MemoryEvent, "before" | "after">) {
  const parts = compare(before, after);
  return <pre className="overview-diff">{parts.map((part, index) => part.kind === "removed" ? <del key={index}>{part.value}</del> :
    part.kind === "added" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</pre>;
}
