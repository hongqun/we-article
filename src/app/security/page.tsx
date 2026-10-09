"use client";
import { useEffect, useState } from "react";
import AppNavigation from "../AppNavigation";
import type { LoginFailure } from "../../lib/login-failures";

export default function SecurityPage() {
  const [failures, setFailures] = useState<LoginFailure[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError("");
    try { const response = await fetch("/api/security/login-failures", { cache: "no-store" }); const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "读取登录记录失败"); setFailures(value.failures); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取登录记录失败"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  return <main className="management-page"><header className="topbar"><div className="brand"><span className="brand-mark">文</span><div><h1>登录记录</h1><p>仅记录失败登录，用于检查异常访问。</p></div></div><AppNavigation /></header>
    <section className="security-panel"><div className="security-heading"><div><h2>失败登录</h2><p>记录保留最近 200 条，IP 来自受信任反向代理头或直接请求。</p></div><button onClick={() => void load()} disabled={loading}>{loading ? "读取中…" : "刷新"}</button></div>{error && <p className="error" role="alert">{error}</p>}
      {failures.length ? <div className="security-table-scroll"><table><thead><tr><th>时间</th><th>IP</th><th>原因</th><th>User-Agent</th></tr></thead><tbody>{failures.map((item, index) => <tr key={`${item.timestamp}-${index}`}><td>{new Date(item.timestamp).toLocaleString("zh-CN")}</td><td>{item.ip}</td><td>{item.reason}</td><td>{item.userAgent}</td></tr>)}</tbody></table></div> : !loading && <p className="hint">暂无失败登录记录。</p>}</section></main>;
}
