import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "dotenv";

// 每轮只读取项目根目录的独立配置，不继承进程环境或其他项目的配置。
export async function readWritingConfig() {
  return parse(await readFile(path.join(process.cwd(), ".env"), "utf8"));
}
