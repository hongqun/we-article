// 样式名称由预览界面与排版接口共同使用。
export const themeNames = {
  ink: "素雅黑", green: "清雅绿", blue: "简洁蓝",
  amber: "暖琥珀", plum: "暮紫", slate: "石墨灰",
} as const;
export type LayoutTheme = keyof typeof themeNames;
