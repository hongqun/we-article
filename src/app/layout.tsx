import type { Metadata } from "next";
import "./globals.css";
import AuthGate from "./AuthGate";

// 本地字体避免启动时依赖额外的字体下载服务。
export const metadata: Metadata = {
  title: "文章工作台",
  description: "从材料解读到写作大纲",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body><AuthGate>{children}</AuthGate></body>
    </html>
  );
}
