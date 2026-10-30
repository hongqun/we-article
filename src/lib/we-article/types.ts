// 独立入口的契约不引用旧 Project 或专题类型。
export interface ArticleSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sourceUrl: string | null;
}
export interface Source { url: string; content: string; createdAt: string }
export interface Article extends ArticleSummary {
  body: string;
  messages: Message[];
}
export type StreamEvent =
  | { type: "status"; message: string }
  | { type: "reasoning"; text: string }
  | { type: "accepted"; article: Article }
  | { type: "reply"; text: string }
  | { type: "done"; article: Article }
  | { type: "error"; message: string };
