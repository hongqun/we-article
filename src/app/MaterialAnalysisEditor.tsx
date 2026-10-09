"use client";

import { useEffect, useRef, useState } from "react";
import {
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  ListsToggle,
  toolbarPlugin,
  UndoRedo,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

type Props = {
  markdown: string;
  disabled?: boolean;
  focusAtEndKey?: number;
  onChange: (markdown: string) => void;
};

// MDXEditor 在一个可编辑框内完成 Markdown 的渲染与反向序列化。
// 组件只输出 Markdown 字符串，具体阶段仍由页面写回对应的 results 字段。
// https://mdxeditor.dev/editor/docs/overview
export default function MaterialAnalysisEditor({
  markdown,
  disabled = false,
  focusAtEndKey = 0,
  onChange,
}: Props) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const [parseFailed, setParseFailed] = useState(false);

  // markdown 属性只在挂载时读取；模型生成新成果后需要通过 ref 同步进编辑器。
  useEffect(() => {
    if (editorRef.current && editorRef.current.getMarkdown() !== markdown) {
      editorRef.current.setMarkdown(markdown);
    }
  }, [markdown]);

  // 只响应生成完成信号，把新成果的光标放到末尾；普通编辑不会反复抢占光标。
  useEffect(() => {
    if (!focusAtEndKey || !editorRef.current) return;
    editorRef.current.focus(undefined, { defaultSelection: "rootEnd" });
  }, [focusAtEndKey]);

  // 不支持的 Markdown 不能静默截断成果；回退到完整原文，仍允许编辑和保存。
  if (parseFailed) {
    return (
      <div>
        <p role="alert">部分格式无法显示，已切换为完整 Markdown 原文。</p>
        <textarea
          className="document-editor"
          aria-label="当前阶段完整 Markdown 内容"
          value={markdown}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }

  // 初次导入的格式归一化不是用户修改，不能触发自动保存或风格学习。
  return (
    <MDXEditor
      ref={editorRef}
      markdown={markdown}
      readOnly={disabled}
      onChange={(value, initialMarkdownNormalize) => {
        if (!initialMarkdownNormalize && value !== markdown) onChange(value);
      }}
      onError={() => setParseFailed(true)}
      placeholder="这一阶段的成果会出现在这里。"
      className="mdxeditor-full-height material-analysis-editor"
      contentEditableClassName="material-analysis-content"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        linkPlugin(),
        tablePlugin(),
        // 模型成果使用 --- 分隔候选项；缺少此插件会在第一条分隔线处中断导入。
        thematicBreakPlugin(),
        // 专题大纲可以内嵌 ```text 模板；导入节点和可编辑视图必须同时注册。
        codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
        codeMirrorPlugin({ codeBlockLanguages: { text: "纯文本", js: "JavaScript", ts: "TypeScript", json: "JSON" } }),
        markdownShortcutPlugin(),
        toolbarPlugin({
          toolbarContents: () => (
            <>
              <UndoRedo />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles />
              <ListsToggle />
              <CreateLink />
            </>
          ),
        }),
      ]}
    />
  );
}
