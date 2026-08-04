import { NextResponse } from "next/server";
import type postgres from "postgres";
import { getSql } from "@/lib/db";
import { ensureV4Schema } from "@/lib/v4/schema";

/** V4 API 共享辅助：数据库句柄（含幂等建表）、鉴权、错误响应 */

let schemaReady = false;

export const getV4Sql = async (): Promise<postgres.Sql | null> => {
  const sql = getSql();
  if (!sql) return null;
  if (!schemaReady) {
    const existing = await sql`select to_regclass('public.import_tasks') as r`;
    if (existing[0]?.r) {
      schemaReady = true;
    } else {
      await ensureV4Schema(sql);
      schemaReady = true;
    }
  }
  return sql;
};

export const dbUnavailable = () =>
  NextResponse.json({ error: "数据库未配置，V4 导入链路不可用" }, { status: 503 });

export const badRequest = (error: string) =>
  NextResponse.json({ error }, { status: 400 });

export const notFound = (error: string) =>
  NextResponse.json({ error }, { status: 404 });

/** 内部调度端点鉴权：DISPATCHER_TOKEN（手动/自链/after 触发）或 CRON_SECRET（Vercel Cron 自动携带） */
export const verifyDispatcherToken = (request: Request): boolean => {
  const expected = process.env.DISPATCHER_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return false;
  if (expected && token === expected) return true;
  if (cronSecret && token === cronSecret) return true;
  return false;
};

/** 处理单元（批次）大小：Vercel Hobby 函数实际约 10s 上限，默认 500 行确保单批在 3~5s 内完成，避免 all-or-nothing 事务被 kill。 */
export const batchSize = (): number =>
  Math.max(100, Number(process.env.V4_BATCH_SIZE || 500));

/** 卡死判定：processing 批次 locked_at 超过该时长即视为被函数 kill，触发恢复/重试。 */
export const stuckBatchSeconds = (): number =>
  Math.max(10, Number(process.env.V4_STUCK_BATCH_SECONDS || 30));

/** 调度租约 TTL：必须 > 单轮 dispatcher 预算，且 < stuck 阈值，保证 kill 后快速让出。 */
export const leaseSeconds = (): number =>
  Math.max(5, Math.min(stuckBatchSeconds() - 5, Number(process.env.V4_DISPATCHER_LEASE_SECONDS || 15)));

/** Dispatcher 端点单轮预算：Hobby 函数上限约 10s，预留 2s 安全余量。 */
export const dispatcherBudgetMs = (): number =>
  Math.max(3000, Math.min(9_000, Number(process.env.V4_DISPATCHER_BUDGET_MS || 8_000)));

/** Dispatcher 端点单轮最大批次数：与 budget 配套，确保在预算内完成。 */
export const dispatcherMaxBatches = (): number =>
  Math.max(1, Number(process.env.V4_DISPATCHER_MAX_BATCHES || 3));

/** 队列积压橙色预警阈值：默认 1000 行，让 500 行/批的 stuck 也能被看见。 */
export const queueBacklogWarnRows = (): number =>
  Math.max(100, Number(process.env.V4_QUEUE_BACKLOG_WARN_ROWS || 1_000));
