// 专题是否可用由配置读取层校验；纯项目逻辑只识别合法专题 ID 格式。
export function isWritingTopic(id: string) {
  return /^[a-z][a-z0-9-]*$/.test(id);
}
