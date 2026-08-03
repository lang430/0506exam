import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";

/** GET /api/import-tasks/:taskId/batches —— 批次状态与性能（考点 5 性能日志出口） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;
  const tasks = await sql`select id from import_tasks where id = ${taskId}`;
  if (!tasks.length) return notFound(`任务 ${taskId} 不存在`);

  const batches = await sql`
    select unit_id, batch_index, start_row, end_row, status, retry_count,
           locked_at, completed_at, success_rows, failed_rows, sku_check_skipped
    from import_task_batches
    where task_id = ${taskId}
    order by batch_index
  `;
  const performance = await sql`
    select unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms,
           insert_duration_ms, total_duration_ms, degraded, status, created_at
    from batch_performance_log
    where task_id = ${taskId}
    order by batch_index
  `;
  return NextResponse.json({
    task_id: taskId,
    batches,
    performance
  });
}
