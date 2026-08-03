import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/runtime-config";

export const getDatabaseUrl = (): string | undefined =>
  getDatabaseConfig().url;

/**
 * 每个 Serverless 实例复用一个 postgres 客户端（单例），空闲 20s 自动释放连接。
 * 历史实现每次请求新建客户端且不关闭，高频轮询下会耗尽 Supabase 连接池（EMAXCONN 200）。
 */
let cachedSql: postgres.Sql | null = null;
let cachedUrl: string | undefined;

export const getSql = (): postgres.Sql | null => {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedSql || cachedUrl !== url) {
    cachedUrl = url;
    cachedSql = postgres(url, {
      ssl: "require",
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10
    });
  }
  return cachedSql;
};
