import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql } from "@/lib/v4/http";

export const runtime = "nodejs";

/**
 * GET /api/import-tasks/:taskId/batches —— 批次状态与性能（考点 5 性能日志出口）
 *
 * 该接口属于详情页的“异步补充数据”，被 3s 轮询调用：
 * 1. 不再做任务存在性探测（任务是否存在由 /api/import-tasks/:taskId 判定），省一次往返；
 * 2. 两条查询并行发出，避免在连接池上串行等待；
 * 3. 结果集设上限，防止超大任务把响应体和渲染拖垮。
 */
const MAX_ROWS = 500;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;

  const [batches, performance] = await Promise.all([
    sql`
      select unit_id, batch_index, start_row, end_row, status, retry_count,
             locked_at, completed_at, success_rows, failed_rows, sku_check_skipped
      from import_task_batches
      where task_id = ${taskId}
      order by batch_index
      limit ${MAX_ROWS}
    `,
    sql`
      select unit_id, batch_index, parse_duration_ms, rule_duration_ms, validate_duration_ms,
             insert_duration_ms, total_duration_ms, degraded, status, created_at
      from batch_performance_log
      where task_id = ${taskId}
      order by batch_index
      limit ${MAX_ROWS}
    `
  ]);

  return NextResponse.json({
    task_id: taskId,
    batches,
    performance
  });
}
