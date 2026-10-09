import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

// 开发服务器绑定全部网口后，手机会用局域网 IP 加载 HMR 资源；启动时自动登记本机可用 IPv4。
const localDevOrigins = Object.values(networkInterfaces()).flatMap(items =>
  (items ?? []).filter(item => item.family === "IPv4" && !item.internal).map(item => item.address),
);

// article 是独立应用，避免根据上级目录的锁文件推断成统一 workspace。
// SQLite 原生模块由 Node 服务端加载，不打入客户端或服务端 bundle。
const config: NextConfig = {
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: ["localhost", "127.0.0.1", ...localDevOrigins],
};
export default function nextConfig(phase: string) {
  // Next 子进程继承运行标记；构建时明确关闭，不能依赖 worker 的命令行推断。
  process.env.ARTICLE_WECHAT_SERVING = ["phase-development-server", "phase-production-server"].includes(phase) ? "1" : "0";
  return config;
}
