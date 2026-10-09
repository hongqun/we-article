// 运行标记由 Next 配置阶段设置，构建和独立脚本都不启动公众号同步。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ARTICLE_WECHAT_SERVING === "1") {
    const { startWechatScheduler } = await import("./lib/wechat/sync");
    startWechatScheduler();
  }
}
