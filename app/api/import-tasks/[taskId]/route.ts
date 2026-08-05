import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/import-tasks/:taskId —— 任务进度查询（前端 1.5s 轮询）
 *
 * 高频轮询接口必须保持只读，不能在请求内认领或处理批次。
 * Worker 由上传 after()、Dispatcher 自链和 cron 推进，查询链路与执行链路隔离。
 */

const TASK_WITH_BATCH_SUMMARY = (sql: Awaited<ReturnType<typeof getV4Sql>>, taskId: string) => sql!`
  select
    t.id, t.file_name, t.status, t.total_rows, t.processed_rows, t.success_rows, t.failed_rows,
    t.total_batches, t.trace_id, t.degraded, t.error_message, t.created_at, t.completed_at,
    b.total_batches as batch_total, b.completed_batches, b.failed_batches
  from import_tasks t
  left join lateral (
    select
      count(*)::int as total_batches,
      count(*) filter (where status = 'completed')::int as completed_batches,
      count(*) filter (where status = 'failed')::int as failed_batches
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

  const rows = await TASK_WITH_BATCH_SUMMARY(sql, taskId);
  const task = rows[0];
  if (!task) return notFound(`任务 ${taskId} 不存在`);

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
