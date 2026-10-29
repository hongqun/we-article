import type { Metadata } from "next";
import WritingWorkspace from "./WritingWorkspace";

export const metadata: Metadata = { title: "We-Article · 写作", description: "对话写作与文章编辑" };
export default function WritingPage() { return <WritingWorkspace />; }
