import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";

/**
 * GET /api/import-tasks/:taskId/errors?batch=4&error_code=E001&page=1&page_size=50
 * 行级错误明细：按批次/错误码筛选 + 分页（考点 4）
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;
  const tasks = await sql`select id from import_tasks where id = ${taskId}`;
  if (!tasks.length) return notFound(`任务 ${taskId} 不存在`);

  const { searchParams } = new URL(request.url);
  const batch = searchParams.get("batch");
  const errorCode = searchParams.get("error_code");
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(searchParams.get("page_size") ?? 50)));
  const offset = (page - 1) * pageSize;

  const rows = await sql`
    select batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, unit_id, created_at
    from import_task_errors
    where task_id = ${taskId}
      and (${batch ?? null}::int is null or batch_index = ${batch ?? null}::int)
      and (${errorCode ?? null}::text is null or error_code = ${errorCode ?? null}::text)
    order by row_number
    limit ${pageSize} offset ${offset}
  `;
  const total = await sql`
    select count(*)::int as c
    from import_task_errors
    where task_id = ${taskId}
      and (${batch ?? null}::int is null or batch_index = ${batch ?? null}::int)
      and (${errorCode ?? null}::text is null or error_code = ${errorCode ?? null}::text)
  `;
  return NextResponse.json({
    task_id: taskId,
    page,
    page_size: pageSize,
    total: Number(total[0]?.c ?? 0),
    errors: rows
  });
}
