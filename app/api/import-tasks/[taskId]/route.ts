import { NextResponse } from "next/server";
import { runDispatchCycle } from "@/lib/v4/dispatch";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/import-tasks/:taskId —— 任务进度查询（前端 1.5s 轮询）
 *
 * 性能约定：本接口是**高频轮询读接口**，必须快速返回，不能在响应前做重活。
 * 早期实现无条件 `await runDispatchCycle(4 批 / 8s)`，导致每次轮询阻塞 2~8s，
 * 前端 1.5s 一次的轮询迅速堆积并触发网关超时。现改为：
 *   1) 任务主表 + 批次聚合 + 活跃处理检测合并为**单次往返**；
 *   2) 仅在任务「停滞」（无批次正在被处理）时才内联推进调度，正常处理中直接返回；
 *   3) 停滞时的调度预算收窄为 1 批 / 2.5s，保证最坏响应时间可控。
 * 主驱动仍是上传 after() → 调度端点自链 → cron 兜底，本接口只做自愈补位。
 */

/** 停滞判定窗口：批次 locked_at 超过该时长仍在 processing，视为无人推进 */
const ACTIVE_PROCESSING_WINDOW_SECONDS = 30;
/** 轮询内联调度预算：仅推进 1 批，硬上限 2.5s，避免拖慢轮询 */
const INLINE_DISPATCH_MAX_BATCHES = 1;
const INLINE_DISPATCH_BUDGET_MS = 2_500;

const TASK_WITH_BATCH_SUMMARY = (sql: Awaited<ReturnType<typeof getV4Sql>>, taskId: string) => sql!`
  select
    t.id, t.file_name, t.status, t.total_rows, t.processed_rows, t.success_rows, t.failed_rows,
    t.total_batches, t.trace_id, t.degraded, t.error_message, t.created_at, t.completed_at,
    b.total_batches as batch_total, b.completed_batches, b.failed_batches, b.active_processing
  from import_tasks t
  left join lateral (
    select
      count(*)::int as total_batches,
      count(*) filter (where status = 'completed')::int as completed_batches,
      count(*) filter (where status = 'failed')::int as failed_batches,
      count(*) filter (
        where status = 'processing'
          and locked_at > now() - make_interval(secs => ${ACTIVE_PROCESSING_WINDOW_SECONDS})
      )::int as active_processing
    from import_task_batches
    where task_id = t.id
  ) b on true
  where t.id = ${taskId}
`;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;

  // 单次往返取回任务主表 + 批次聚合 + 活跃处理检测（原为 2 次独立查询）
  let rows = await TASK_WITH_BATCH_SUMMARY(sql, taskId);
  let task = rows[0];
  if (!task) return notFound(`任务 ${taskId} 不存在`);

  // 自愈兜底：仅当任务未终态**且当前无批次正在被处理**（即调度停滞）时才内联推进。
  // 正常处理中的轮询完全不做调度工作，响应回到 ~100ms 量级。
  const isRunning = ["pending", "processing"].includes(String(task.status));
  const isStalled = isRunning && Number(task.active_processing ?? 0) === 0;
  if (isStalled) {
    try {
      const cycle = await runDispatchCycle(sql, {
        maxBatches: INLINE_DISPATCH_MAX_BATCHES,
        timeBudgetMs: INLINE_DISPATCH_BUDGET_MS
      });
      // 真正推进了批次才回读一次，保证返回的进度不滞后（被租约跳过则无需回读）
      if (!cycle.skippedByLock && cycle.processed.length > 0) {
        rows = await TASK_WITH_BATCH_SUMMARY(sql, taskId);
        task = rows[0] ?? task;
      }
    } catch (error) {
      console.error("[v4] inline dispatch failed", error instanceof Error ? error.message : error);
    }
  }

  // 错误分布仅在确有失败行时查询，成功路径省去一次往返
  const failedRows = Number(task.failed_rows);
  const errorSummary = failedRows > 0
    ? await sql`
        select error_code, count(*)::int as c
        from import_task_errors where task_id = ${taskId}
        group by error_code order by c desc limit 5
      `
    : [];

  const totalRows = Number(task.total_rows);
  const processedRows = Number(task.processed_rows);
  const createdAt = new Date(task.created_at as unknown as string).getTime();
  const elapsedSeconds = Math.max((Date.now() - createdAt) / 1000, 1);
  const throughputPerSec = processedRows / elapsedSeconds;
  const remainingRows = Math.max(totalRows - processedRows, 0);
  return NextResponse.json({
    task_id: task.id,
    file_name: task.file_name,
    status: String(task.status).toUpperCase(),
    status_raw: task.status,
    total_rows: totalRows,
    processed_rows: processedRows,
    success_rows: Number(task.success_rows),
    failed_rows: failedRows,
    total_batches: Number(task.batch_total ?? task.total_batches),
    completed_batches: Number(task.completed_batches ?? 0),
    failed_batches: Number(task.failed_batches ?? 0),
    degraded: Boolean(task.degraded),
    trace_id: task.trace_id,
    error_message: task.error_message,
    throughput_per_sec: Math.round(throughputPerSec * 10) / 10,
    eta_seconds: throughputPerSec > 0 ? Math.round(remainingRows / throughputPerSec) : null,
    recent_errors: errorSummary.map((row) => ({ error_code: row.error_code, count: Number(row.c) })),
    created_at: task.created_at,
    completed_at: task.completed_at
  });
}
