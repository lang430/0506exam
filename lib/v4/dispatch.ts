import type postgres from "postgres";
import { leaseSeconds } from "@/lib/v4/http";
import { claimReadyBatches, dispatchOutbox, recoverStuckBatches } from "@/lib/v4/queue";
import { recordTraceEvents } from "@/lib/v4/trace";
import { processBatch, type BatchOutcome } from "@/lib/v4/worker";

/**
 * 调度循环：Outbox 投递 → 卡死恢复 → 认领并处理就绪批次。
 * 供 /api/import-dispatcher（Vercel Cron / 自链式调用）与本地 worker-loop 复用。
 * 设计为无状态：任意时刻重启都能从 event_outbox 与批次状态继续。
 *
 * 并发控制：使用 dispatch_lease 租约表保证全局同一时刻只有一个调度循环在处理批次。
 * 多实例并发抢批会让小规格数据库被并行重事务拖垮（实测教训），
 * 串行单处理器 + SKIP LOCKED 认领在本规模下吞吐更稳；租约自动过期，冻结实例不会永久阻塞。
 */

export interface DispatchCycleResult {
  outbox: { scanned: number; sent: number; failed: number };
  recovered: number;
  deadLettered: number;
  processed: BatchOutcome[];
  elapsedMs: number;
  skippedByLock?: boolean;
}

/**
 * 租约锁：INSERT ... ON CONFLICT 条件更新实现 CAS 抢占。
 * 只有“租约已过期”或“自己是当前持有者”时才能写入成功；
 * Serverless 实例被冻结/杀死后租约自动过期，其他实例可接管。
 */
const acquireOrRenewLease = async (sql: postgres.Sql, owner: string): Promise<boolean> => {
  const rows = await sql`
    insert into dispatch_lease (key, owner, expires_at)
    values (1, ${owner}, now() + make_interval(secs => ${leaseSeconds()}))
    on conflict (key) do update
      set owner = excluded.owner, expires_at = excluded.expires_at, acquired_at = now()
      where dispatch_lease.expires_at < now() or dispatch_lease.owner = excluded.owner
    returning owner
  `;
  return rows.length > 0;
};

const releaseLease = async (sql: postgres.Sql, owner: string): Promise<void> => {
  try {
    await sql`update dispatch_lease set expires_at = now() where key = 1 and owner = ${owner}`;
  } catch {
    /* 租约过期即自然释放 */
  }
};

export const runDispatchCycle = async (
  sql: postgres.Sql,
  options: { maxBatches?: number; timeBudgetMs?: number } = {}
): Promise<DispatchCycleResult> => {
  const startedAt = Date.now();
  const maxBatches = options.maxBatches ?? 20;
  const timeBudgetMs = options.timeBudgetMs ?? 45_000;
  const owner = `cycle_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

  if (!(await acquireOrRenewLease(sql, owner))) {
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
      // 每批完成后续租，防止长任务租约过期被接管
      if (!(await acquireOrRenewLease(sql, owner))) break;
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
    await releaseLease(sql, owner);
  }
};
