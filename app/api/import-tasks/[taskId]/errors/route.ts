import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql } from "@/lib/v4/http";

export const runtime = "nodejs";

/**
 * GET /api/import-tasks/:taskId/errors?batch=4&error_code=E001&page=1&page_size=50
 * 行级错误明细：按批次/错误码筛选 + 分页（考点 4）
 *
 * 详情页的异步补充数据：不再做任务存在性探测（由 /api/import-tasks/:taskId 判定 404），
 * 明细与总数并行查询，减少轮询在连接池上的占用时间。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;

  const { searchParams } = new URL(request.url);
  const batch = searchParams.get("batch");
  const errorCode = searchParams.get("error_code");
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(searchParams.get("page_size") ?? 50)));
  const offset = (page - 1) * pageSize;

  const [rows, total] = await Promise.all([
    sql`
      select batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, unit_id, created_at
      from import_task_errors
      where task_id = ${taskId}
        and (${batch ?? null}::int is null or batch_index = ${batch ?? null}::int)
        and (${errorCode ?? null}::text is null or error_code = ${errorCode ?? null}::text)
      order by row_number
      limit ${pageSize} offset ${offset}
    `,
    sql`
      select count(*)::int as c
      from import_task_errors
      where task_id = ${taskId}
        and (${batch ?? null}::int is null or batch_index = ${batch ?? null}::int)
        and (${errorCode ?? null}::text is null or error_code = ${errorCode ?? null}::text)
    `
  ]);
  return NextResponse.json({
    task_id: taskId,
    page,
    page_size: pageSize,
    total: Number(total[0]?.c ?? 0),
    errors: rows
  });
}
