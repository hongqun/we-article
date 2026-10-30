// 独立入口的契约不引用旧 Project 或专题类型。
export interface ArticleSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  accountId: string | null;
  topicId: string | null;
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

// 创作配置只保存名称与自然语言要求，不沿用旧专题的技术字段。
export interface ConfigurationDraft { name: string; content: string }
export interface WritingAccount extends ConfigurationDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface ConfigurationSource { id: string; title: string; body: string }
export interface WritingTopic extends WritingAccount {
  accountId: string;
  sources: ConfigurationSource[];
}
export interface ArticleSelection { accountId: string | null; topicId: string | null }
export interface ConfigurationSessionSummary {
  id: string;
  kind: "account" | "topic";
  name: string;
  updatedAt: string;
}
export interface ConfigurationSession {
  id: string;
  kind: "account" | "topic";
  accountId: string | null;
  targetId: string | null;
  confirmedId: string | null;
  draft: ConfigurationDraft;
  messages: { role: "user" | "assistant"; content: string }[];
  sources: ConfigurationSource[];
  updatedAt: string;
}
export interface WritingConfiguration {
  accounts: WritingAccount[];
  topics: WritingTopic[];
  sessions: ConfigurationSessionSummary[];
}
