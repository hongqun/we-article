import { ChatDeepSeek } from "@langchain/deepseek";
import type { OpenAIClient } from "@langchain/openai";

// 消息随本次调用传递，不使用共享状态或 HTTP 拦截。
const reasoningMessages = Symbol("reasoningMessages");
type ModelMessages = Parameters<ChatDeepSeek["_generate"]>[0];
type RequestOptions = OpenAIClient.RequestOptions & { [reasoningMessages]?: ModelMessages };

function withMessages(options: ChatDeepSeek["ParsedCallOptions"], messages: ModelMessages) {
  return {
    ...options,
    [reasoningMessages]: messages,
    options: { ...options.options, [reasoningMessages]: messages },
  };
}

export class WritingModel extends ChatDeepSeek {
  override _generate(...[messages, options, runManager]: Parameters<ChatDeepSeek["_generate"]>) {
    return super._generate(messages, withMessages(options, messages), runManager);
  }

  override _streamResponseChunks(...[messages, options, runManager]: Parameters<ChatDeepSeek["_streamResponseChunks"]>) {
    return super._streamResponseChunks(messages, withMessages(options, messages), runManager);
  }

  override _streamChatModelEvents(...[messages, options, runManager]: Parameters<ChatDeepSeek["_streamChatModelEvents"]>) {
    return super._streamChatModelEvents(messages, withMessages(options, messages), runManager);
  }

  override completionWithRetry(
    request: OpenAIClient.Chat.ChatCompletionCreateParamsStreaming,
    options?: RequestOptions,
  ): Promise<AsyncIterable<OpenAIClient.Chat.Completions.ChatCompletionChunk>>;
  override completionWithRetry(
    request: OpenAIClient.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: RequestOptions,
  ): Promise<OpenAIClient.Chat.Completions.ChatCompletion>;
  override completionWithRetry(request: OpenAIClient.Chat.ChatCompletionCreateParams, options?: RequestOptions) {
    const { [reasoningMessages]: messages, ...requestOptions } = options ?? {};
    const thinking = this.modelKwargs?.thinking as { type?: string } | undefined;
    if (messages && thinking?.type === "enabled" && request.tools?.length) {
      const assistants = messages.filter(message => message.type === "ai");
      let index = 0;
      // LangChain 已解析响应字段，但转换下一次请求时会遗漏；在模型请求边界补回。
      request = {
        ...request,
        messages: request.messages.map(message => {
          if (message.role !== "assistant") return message;
          const reasoning = assistants[index++]?.additional_kwargs.reasoning_content;
          return { ...message, reasoning_content: typeof reasoning === "string" ? reasoning : "" };
        }),
      };
    }
    return request.stream
      ? super.completionWithRetry(request, requestOptions)
      : super.completionWithRetry({ ...request, stream: false }, requestOptions);
  }
}
