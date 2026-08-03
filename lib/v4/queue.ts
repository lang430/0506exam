import type postgres from "postgres";
import { ImportEvents, type EventEnvelope } from "@/lib/v4/events";

/**
 * PG 原生任务队列（等效异步任务系统）：
 * - event_outbox：本地可靠事件表，与任务创建同事务写入（Transactional Outbox）；
 * - import_task_batches(status='ready')：队列体，Dispatcher 投递后由 Worker 用
 *   FOR UPDATE SKIP LOCKED 并发安全认领；
 * - 重试：retry_count + next_retry_at 指数退避；失败：status='failed'（死信）；
 * - 宕机恢复：Dispatcher 无状态，重启后继续扫描 pending Outbox 与 ready 批次。
 */

export type BatchRow = {
  id: string;
  task_id: string;
  unit_id: string;
  batch_index: number;
  start_row: number;
  end_row: number;
  status: string;
  retry_count: number;
  locked_at: Date | null;
  completed_at: Date | null;
  success_rows: string | number;
  failed_rows: string | number;
  sku_check_skipped: boolean;
};

export type OutboxRow = {
  id: string;
  event_id: string;
  event_type: string;
  schema_version: number;
  aggregate_id: string;
  trace_id: string;
  payload: unknown;
  status: string;
  retry_count: number;
  next_retry_at: Date;
  created_at: Date;
  sent_at: Date | null;
};

export const MAX_OUTBOX_RETRY = 5;
export const MAX_BATCH_RETRY = 3;
export const STUCK_BATCH_MINUTES = 2;

/** 与任务创建同事务写入 Outbox（event_id 幂等） */
export const enqueueEvents = async (
  tx: postgres.TransactionSql,
  envelopes: EventEnvelope[]
): Promise<void> => {
  if (!envelopes.length) return;
  const rows = envelopes.map((envelope) => ({
    event_id: envelope.event_id,
    event_type: envelope.event_type,
    schema_version: envelope.schema_version,
    aggregate_id: envelope.aggregate_id,
    trace_id: envelope.trace_id,
    payload: tx.json(envelope as unknown as Parameters<typeof tx.json>[0])
  }));
  await tx`
    insert into event_outbox
    ${tx(rows, "event_id", "event_type", "schema_version", "aggregate_id", "trace_id", "payload")}
    on conflict (event_id) do nothing
  `;
};

export interface DispatchResult {
  scanned: number;
  sent: number;
  failed: number;
}

/**
 * Dispatcher：扫描到期 Outbox 事件并投递。
 * ImportBatchCreated → 将对应批次置为 ready（入队）；
 * ImportTaskCreated / 其他 → 记录即视为投递成功（任务与批次已同事务落库）。
 */
export const dispatchOutbox = async (sql: postgres.Sql, batchSize = 50): Promise<DispatchResult> => {
  return sql.begin(async (tx) => {
    const events = await tx<OutboxRow[]>`
      select * from event_outbox
      where status = 'pending' and next_retry_at <= now()
      order by created_at
      for update skip locked
      limit ${batchSize}
    `;
    let sent = 0;
    let failed = 0;
    for (const event of events) {
      try {
        if (event.event_type === ImportEvents.ImportBatchCreated) {
          let rawPayload: unknown = event.payload;
          if (typeof rawPayload === "string") {
            try { rawPayload = JSON.parse(rawPayload); } catch { rawPayload = {}; }
          }
          if (typeof rawPayload === "string") {
            try { rawPayload = JSON.parse(rawPayload); } catch { rawPayload = {}; }
          }
          const envelopeLike = (rawPayload ?? {}) as { payload?: { task_id?: string; unit_id?: string } };
          const payload = (envelopeLike.payload ?? envelopeLike) as { task_id?: string; unit_id?: string };
          const taskId = payload.task_id ?? "";
          const unitId = payload.unit_id ?? "";
          if (taskId && unitId) {
            await tx`
              update import_task_batches
              set status = 'ready'
              where task_id = ${taskId} and unit_id = ${unitId} and status = 'pending'
            `;
          }
        }
        await tx`update event_outbox set status = 'sent', sent_at = now() where id = ${event.id}`;
        sent += 1;
      } catch {
        failed += 1;
        const retryCount = event.retry_count + 1;
        if (retryCount >= MAX_OUTBOX_RETRY) {
          await tx`update event_outbox set status = 'failed', retry_count = ${retryCount} where id = ${event.id}`;
        } else {
          const backoffSeconds = Math.min(2 ** retryCount * 5, 300);
          await tx`
            update event_outbox
            set retry_count = ${retryCount}, next_retry_at = now() + make_interval(secs => ${backoffSeconds})
            where id = ${event.id}
          `;
        }
      }
    }
    return { scanned: events.length, sent, failed };
  });
};

/** Worker 认领就绪批次：FOR UPDATE SKIP LOCKED 保证并发安全、不重复领取 */
export const claimReadyBatches = async (sql: postgres.Sql, limit = 1): Promise<BatchRow[]> => {
  return sql<BatchRow[]>`
    update import_task_batches
    set status = 'processing', locked_at = now(), retry_count = retry_count + 1
    where id in (
      select id from import_task_batches
      where status = 'ready'
      order by task_id, batch_index
      for update skip locked
      limit ${limit}
    )
    returning *
  `;
};

/** 卡死恢复：processing 超时的批次重置为 ready（重试）或标记 failed（死信） */
export const recoverStuckBatches = async (sql: postgres.Sql): Promise<{ recovered: number; deadLettered: number }> => {
  const recovered = await sql`
    update import_task_batches
    set status = 'ready', locked_at = null
    where status = 'processing'
      and locked_at < now() - make_interval(mins => ${STUCK_BATCH_MINUTES})
      and retry_count < ${MAX_BATCH_RETRY}
    returning id
  `;
  const deadLettered = await sql`
    update import_task_batches
    set status = 'failed', completed_at = now()
    where status = 'processing'
      and locked_at < now() - make_interval(mins => ${STUCK_BATCH_MINUTES})
      and retry_count >= ${MAX_BATCH_RETRY}
    returning id
  `;
  return { recovered: recovered.length, deadLettered: deadLettered.length };
};

/**
 * 任务终态聚合：所有批次结束后根据成功/失败分布确定任务状态。
 * 条件更新保证并发 Worker 只有一个成功写入终态（幂等）。
 */
export const finalizeTaskIfNeeded = async (
  sql: postgres.Sql,
  taskId: string
): Promise<{ finalized: boolean; status?: string }> => {
  const remaining = await sql`
    select count(*)::int as c from import_task_batches
    where task_id = ${taskId} and status in ('pending', 'ready', 'processing')
  `;
  if (Number(remaining[0]?.c ?? 0) > 0) return { finalized: false };

  const summary = await sql`
    select
      count(*)::int as total,
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'failed')::int as failed,
      coalesce(sum(success_rows), 0)::bigint as success_rows,
      coalesce(sum(failed_rows), 0)::bigint as failed_rows
    from import_task_batches
    where task_id = ${taskId}
  `;
  const row = summary[0];
  const total = Number(row?.total ?? 0);
  const completedCount = Number(row?.completed ?? 0);
  const successRows = Number(row?.success_rows ?? 0);
  const failedRows = Number(row?.failed_rows ?? 0);
  let status: "completed" | "partial_success" | "failed";
  if (total > 0 && completedCount === 0) status = "failed";
  else if (failedRows > 0 || (total > 0 && completedCount < total)) status = "partial_success";
  else status = "completed";

  const updated = await sql`
    update import_tasks
    set status = ${status},
        success_rows = greatest(success_rows, ${successRows}),
        failed_rows = greatest(failed_rows, ${failedRows}),
        processed_rows = greatest(processed_rows, ${successRows + failedRows}),
        completed_at = now()
    where id = ${taskId} and status in ('pending', 'processing')
    returning id, status
  `;
  return { finalized: updated.length > 0, status: updated[0]?.status };
};
