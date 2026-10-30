import type { Metadata } from "next";
import "./globals.css";

// 本地字体避免启动时依赖额外的字体下载服务。
export const metadata: Metadata = {
  title: "We-Article · 写作",
  description: "对话写作与文章编辑",
  icons: { icon: "/logo-mark.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
