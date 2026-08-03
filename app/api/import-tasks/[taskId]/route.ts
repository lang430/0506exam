import { NextResponse } from "next/server";
import { runDispatchCycle } from "@/lib/v4/dispatch";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/import-tasks/:taskId —— 任务进度查询（前端 1~2s 轮询，附带自愈调度） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;
  const tasks = await sql`
    select id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
           total_batches, trace_id, degraded, error_message, created_at, completed_at
    from import_tasks where id = ${taskId}
  `;
  const task = tasks[0];
  if (!task) return notFound(`任务 ${taskId} 不存在`);

  // 自愈兜底：非终态任务被轮询时内联推进调度（请求生命周期内执行，必然释放租约；
  // Hobby 计划 after() 随实例挂起且会持租约阻塞其他循环，故不再使用 after 调度）
  if (["pending", "processing"].includes(String(task.status))) {
    try {
      await runDispatchCycle(sql, { maxBatches: 4, timeBudgetMs: 8_000 });
    } catch (error) {
      console.error("[v4] inline dispatch failed", error instanceof Error ? error.message : error);
    }
  }
  const batchSummary = await sql`
    select
      count(*)::int as total_batches,
      count(*) filter (where status = 'completed')::int as completed_batches,
      count(*) filter (where status = 'failed')::int as failed_batches
    from import_task_batches where task_id = ${taskId}
  `;
  const errorSummary = await sql`
    select error_code, count(*)::int as c
    from import_task_errors where task_id = ${taskId}
    group by error_code order by c desc limit 5
  `;
  const batches = batchSummary[0];
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
    failed_rows: Number(task.failed_rows),
    total_batches: Number(batches?.total_batches ?? task.total_batches),
    completed_batches: Number(batches?.completed_batches ?? 0),
    failed_batches: Number(batches?.failed_batches ?? 0),
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
