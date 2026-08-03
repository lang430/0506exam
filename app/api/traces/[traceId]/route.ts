import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql } from "@/lib/v4/http";

export const runtime = "nodejs";

/**
 * GET /api/traces/:traceId —— 全链路时间线
 * 支持 ?task_id / batch / row_from / row_to / error_code 组合检索
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ traceId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { traceId } = await params;
  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("task_id");
  const batch = searchParams.get("batch");
  const rowFrom = searchParams.get("row_from");
  const rowTo = searchParams.get("row_to");
  const errorCode = searchParams.get("error_code");

  const timeline = await sql`
    select trace_id, task_id, unit_id, event_name, event_status, message, occurred_at
    from trace_events
    where trace_id = ${traceId}
      and (${taskId ?? null}::text is null or task_id = ${taskId ?? null}::text)
    order by occurred_at
    limit 500
  `;
  const errors = await sql`
    select task_id, unit_id, batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion, created_at
    from import_task_errors
    where trace_id = ${traceId}
      and (${taskId ?? null}::text is null or task_id = ${taskId ?? null}::text)
      and (${batch ?? null}::int is null or batch_index = ${batch ?? null}::int)
      and (${rowFrom ?? null}::int is null or row_number >= ${rowFrom ?? null}::int)
      and (${rowTo ?? null}::int is null or row_number <= ${rowTo ?? null}::int)
      and (${errorCode ?? null}::text is null or error_code = ${errorCode ?? null}::text)
    order by row_number
    limit 500
  `;
  const batches = await sql`
    select b.unit_id, b.batch_index, b.status, b.retry_count, b.success_rows, b.failed_rows,
           p.parse_duration_ms, p.rule_duration_ms, p.validate_duration_ms, p.insert_duration_ms, p.total_duration_ms
    from import_task_batches b
    left join batch_performance_log p on p.task_id = b.task_id and p.unit_id = b.unit_id
    where b.task_id in (select task_id from trace_events where trace_id = ${traceId} limit 1)
    order by b.batch_index
  `;
  // 任务与所属规则（失败节点上下文：规则名/规则 ID）
  const taskRows = await sql`
    select t.id, t.file_name, t.status, t.rule_id, t.degraded, t.created_at, t.completed_at,
           r.payload->>'name' as rule_name
    from import_tasks t
    left join parse_rules r on r.id = t.rule_id
    where t.trace_id = ${traceId}
    order by t.created_at desc
    limit 1
  `;
  return NextResponse.json({ trace_id: traceId, task: taskRows[0] ?? null, timeline, errors, batches });
}
