import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql } from "@/lib/v4/http";

export const runtime = "nodejs";

/**
 * GET /api/traces —— 多条件 Trace 检索（task_id / 文件名 / 批次号 / 错误码 / 行号范围 → 命中的 trace 列表）
 * 命中后前端再用 /api/traces/:traceId 拉时间线。
 */
export async function GET(request: Request) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("task_id")?.trim() || null;
  const traceId = searchParams.get("trace_id")?.trim() || null;
  const fileName = searchParams.get("file_name")?.trim() || null;
  const errorCode = searchParams.get("error_code")?.trim() || null;
  const batch = searchParams.get("batch")?.trim() || null;
  const rowFrom = searchParams.get("row_from")?.trim() || null;
  const rowTo = searchParams.get("row_to")?.trim() || null;

  if (traceId) {
    const taskTraces = await sql`
      select id as task_id, file_name, trace_id, status, total_rows, success_rows, failed_rows, created_at
      from import_tasks where trace_id = ${traceId}
      order by created_at desc limit 20
    `;
    return NextResponse.json({ traces: taskTraces });
  }

  if (taskId && !fileName && !errorCode && !batch && !rowFrom && !rowTo) {
    const taskTraces = await sql`
      select id as task_id, file_name, trace_id, status, total_rows, success_rows, failed_rows, created_at
      from import_tasks where id = ${taskId}
      limit 1
    `;
    return NextResponse.json({ traces: taskTraces });
  }

  if (!taskId && !fileName && !errorCode && !batch && !rowFrom && !rowTo) {
    const taskTraces = await sql`
      select id as task_id, file_name, trace_id, status, total_rows, success_rows, failed_rows, created_at
      from import_tasks order by created_at desc limit 20
    `;
    return NextResponse.json({ traces: taskTraces });
  }

  const taskTraces = await sql`
    select id as task_id, file_name, trace_id, status, total_rows, success_rows, failed_rows, created_at
    from import_tasks
    where (${taskId}::text is null or id = ${taskId}::text)
      and (${fileName}::text is null or file_name ilike ${fileName ? `%${fileName}%` : null})
      and (
        ${batch}::int is null
        or exists (
          select 1 from import_task_errors e
          where e.task_id = import_tasks.id and e.batch_index = ${batch}::int
        )
      )
      and (
        (${errorCode}::text is null and ${rowFrom}::int is null and ${rowTo}::int is null)
        or exists (
          select 1 from import_task_errors e
          where e.task_id = import_tasks.id
            and (${errorCode}::text is null or e.error_code = ${errorCode}::text)
            and (${rowFrom}::int is null or e.row_number >= ${rowFrom}::int)
            and (${rowTo}::int is null or e.row_number <= ${rowTo}::int)
        )
      )
    order by created_at desc
    limit 20
  `;
  return NextResponse.json({ traces: taskTraces });
}
