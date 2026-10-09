"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "写作工作台" },
  { href: "/projects", label: "文章管理" },
  { href: "/style-memory", label: "风格记忆" },
  { href: "/overview", label: "架构与统计" },
  { href: "/security", label: "登录记录" },
];

export default function AppNavigation({ onNavigate }: { onNavigate?: (href: string) => void }) {
  const pathname = usePathname();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  }
  return <nav className="app-navigation" aria-label="文章工作台菜单">
    {items.map(item => onNavigate ? <button key={item.href} type="button"
      className={pathname === item.href ? "active" : ""} aria-current={pathname === item.href ? "page" : undefined}
      onClick={() => onNavigate(item.href)}>{item.label}</button> : <Link key={item.href} href={item.href}
        className={pathname === item.href ? "active" : ""} aria-current={pathname === item.href ? "page" : undefined}>{item.label}</Link>)}
    <button type="button" className="logout-button" onClick={() => void logout()}>退出登录</button>
  </nav>;
}
