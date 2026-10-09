import { readTopicFile, readWritingTopic } from "./topics";

export const articleContentPlaceholder = "[在此输入文章内容]";
// 组装在服务端完成，专题配置不会被打进浏览器，也不会写入任何项目资产。
export function assembleImagePrompt(template: string, articleMarkdown: string) {
  if (!articleMarkdown.trim()) throw new Error("请先填写正文，再查看配图提示词。");
  const occurrences = template.split(articleContentPlaceholder).length - 1;
  if (occurrences !== 1) throw new Error("配图提示词配置中的文章占位符必须且只能出现一次。");
  return template.replace(articleContentPlaceholder, articleMarkdown);
}

export async function buildImagePrompt(topicId: string, articleMarkdown: string) {
  const topic = await readWritingTopic(topicId);
  if (!topic.imagePromptFile) throw new Error("当前专题未配置配图提示词。");
  const template = await readTopicFile(topicId, topic.imagePromptFile);
  return assembleImagePrompt(template, articleMarkdown);
}
