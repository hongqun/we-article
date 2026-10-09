"use client";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    // 手机密码输入和系统自动填充偶尔不会同步 React 状态，提交时以原生表单值为准。
    const submittedPassword = String(new FormData(event.currentTarget).get("password") ?? "");
    if (!submittedPassword) { setError("请输入应用密码"); setBusy(false); return; }
    try { const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: submittedPassword }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "登录失败"); window.location.replace("/"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); }
    finally { setBusy(false); }
  }
  return <main className="login-page"><form className="login-card" onSubmit={submit}><p className="login-eyebrow">ARTICLE / WRITING DESK</p><h1>登录工作台</h1><p className="login-hint">使用应用密码进入文章创作平台。</p><label>应用密码<input autoFocus name="password" type="password" value={password} onChange={event => setPassword(event.currentTarget.value)} onInput={event => setPassword(event.currentTarget.value)} /></label>{error && <p className="login-error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? "登录中…" : "进入工作台"}</button></form></main>;
}
