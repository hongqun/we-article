"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

// 客户端页面保持原有结构；入口先确认 HttpOnly 会话，避免未登录时请求业务数据。
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname(), router = useRouter();
  const [ready, setReady] = useState(pathname === "/login");
  useEffect(() => {
    if (pathname === "/login") { setReady(true); return; }
    setReady(false);
    void fetch("/api/auth/session", { cache: "no-store" }).then(response => { if (!response.ok) router.replace("/login"); else setReady(true); }).catch(() => router.replace("/login"));
  }, [pathname, router]);
  if (!ready) return <main className="loading">正在检查登录状态…</main>;
  return <>{children}</>;
}
