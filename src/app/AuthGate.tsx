"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// 客户端页面保持原有结构；入口先确认 HttpOnly 会话，避免未登录时请求业务数据。
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(), router = useRouter();
  // 独立 MVP 精确放行，其他页面继续检查原有登录会话。
  const publicPage = pathname === "/login" || pathname === "/we-article";
  const [ready, setReady] = useState(publicPage);
  useEffect(() => {
    if (publicPage) { setReady(true); return; }
    setReady(false);
    // 路由切换后忽略旧检查，避免迟到的响应把免登录入口重定向走。
    let active = true;
    void fetch("/api/auth/session", { cache: "no-store" }).then(response => {
      if (!active) return;
      if (!response.ok) router.replace("/login"); else setReady(true);
    }).catch(() => { if (active) router.replace("/login"); });
    return () => { active = false; };
  }, [pathname, publicPage, router]);
  if (!ready) return <main className="loading">正在检查登录状态…</main>;
  return <>{children}</>;
}
