import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/runtime-config";

export const getDatabaseUrl = (): string | undefined =>
  getDatabaseConfig().url;

/**
 * 请求链路连接数。
 * 历史值为 1：任务详情页同时轮询 任务/错误明细/批次 三个接口，外加顶栏监控，
 * 单连接下这些只读查询只能串行排队，任一慢查询就会把后面的请求拖到网关超时。
 * transaction pooler 本身就是为多连接设计的，这里保留小池即可（默认 5，可用环境变量下调）。
 */
export const requestPoolMax = (): number =>
  Math.max(1, Math.min(10, Number(process.env.V4_PG_POOL_MAX || 5)));

/** 后台调度为全局单处理器串行消费，2 条连接足够（1 条跑循环 + 1 条续租/兜底）。 */
export const backgroundPoolMax = (): number =>
  Math.max(1, Math.min(5, Number(process.env.V4_PG_BG_POOL_MAX || 2)));

/** Supabase transaction pooler 不支持跨后端复用 prepared statements。 */
export const getPostgresOptions = (max: number = requestPoolMax()) => ({
  ssl: "require" as const,
  max,
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
 * 后台调度循环专用客户端（独立连接池）。
 * 调度单轮预算 8s 且积压时自链续跑，若与请求共用连接池，
 * 任务详情轮询会全程排在调度事务后面，直接表现为接口超时 / 页面卡在“加载任务中”。
 */
let cachedBgSql: postgres.Sql | null = null;
let cachedBgUrl: string | undefined;

export const getBackgroundSql = (): postgres.Sql | null => {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!cachedBgSql || cachedBgUrl !== url) {
    cachedBgUrl = url;
    cachedBgSql = postgres(url, getPostgresOptions(backgroundPoolMax()));
  }
  return cachedBgSql;
};
