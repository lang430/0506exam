import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/runtime-config";

export const getDatabaseUrl = (): string | undefined =>
  getDatabaseConfig().url;

/** Supabase transaction pooler 不支持跨后端复用 prepared statements。 */
export const getPostgresOptions = () => ({
  ssl: "require" as const,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false
});

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
    cachedSql = postgres(url, getPostgresOptions());
  }
  return cachedSql;
};

/**
 * 后台调度循环专用客户端（独立连接）。
 * after() 调度循环若与请求共用单连接，长循环会阻塞后续请求查询导致 504。
 */
let cachedBgSql: postgres.Sql | null = null;
let cachedBgUrl: string | undefined;

export const getBackgroundSql = (): postgres.Sql | null => {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedBgSql || cachedBgUrl !== url) {
    cachedBgUrl = url;
    cachedBgSql = postgres(url, getPostgresOptions());
  }
  return cachedBgSql;
};
