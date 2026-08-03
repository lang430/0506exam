import type postgres from "postgres";
import { claimReadyBatches, dispatchOutbox, recoverStuckBatches } from "@/lib/v4/queue";
import { recordTraceEvents } from "@/lib/v4/trace";
import { processBatch, type BatchOutcome } from "@/lib/v4/worker";

/**
 * 调度循环：Outbox 投递 → 卡死恢复 → 认领并处理就绪批次。
 * 供 /api/import-dispatcher（Vercel Cron / 自链式调用）与本地 worker-loop 复用。
 * 设计为无状态：任意时刻重启都能从 event_outbox 与批次状态继续。
 *
 * 并发控制：使用 PG 咨询锁保证全局同一时刻只有一个调度循环在处理批次。
 * 多实例并发抢批会让小规格数据库被并行重事务拖垮（实测教训），
 * 串行单处理器 + SKIP LOCKED 认领在本规模下吞吐更稳。连接断开锁自动释放。
 */

const DISPATCH_ADVISORY_LOCK_KEY = 20260803;

export interface DispatchCycleResult {
  outbox: { scanned: number; sent: number; failed: number };
  recovered: number;
  deadLettered: number;
  processed: BatchOutcome[];
  elapsedMs: number;
  skippedByLock?: boolean;
}

export const runDispatchCycle = async (
  sql: postgres.Sql,
  options: { maxBatches?: number; timeBudgetMs?: number } = {}
): Promise<DispatchCycleResult> => {
  const startedAt = Date.now();
  const maxBatches = options.maxBatches ?? 20;
  const timeBudgetMs = options.timeBudgetMs ?? 45_000;

  const lockRows = await sql`select pg_try_advisory_lock(${DISPATCH_ADVISORY_LOCK_KEY}) as acquired`;
  if (!lockRows[0]?.acquired) {
    return { outbox: { scanned: 0, sent: 0, failed: 0 }, recovered: 0, deadLettered: 0, processed: [], elapsedMs: Date.now() - startedAt, skippedByLock: true };
  }

  try {
    const outbox = await dispatchOutbox(sql);
    const { recovered, deadLettered } = await recoverStuckBatches(sql);

    const processed: BatchOutcome[] = [];
    while (processed.length < maxBatches && Date.now() - startedAt < timeBudgetMs) {
      const claimed = await claimReadyBatches(sql, 1);
      const batch = claimed[0];
      if (!batch) break;
      const outcome = await processBatch(sql, batch);
      processed.push(outcome);
    }

    if (deadLettered > 0) {
      await recordTraceEvents(sql, [{
        traceId: "system",
        taskId: "",
        unitId: "",
        eventName: "BatchDeadLettered",
        eventStatus: "error",
        message: `${deadLettered} 个批次重试超限，转入失败（死信）`
      }]);
    }

    return { outbox, recovered, deadLettered, processed, elapsedMs: Date.now() - startedAt };
  } finally {
    await sql`select pg_advisory_unlock(${DISPATCH_ADVISORY_LOCK_KEY})`.catch(() => undefined);
  }
};
