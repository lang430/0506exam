import { NextResponse } from "next/server";
import { dbUnavailable, getV4Sql, notFound } from "@/lib/v4/http";

export const runtime = "nodejs";

/** GET /api/import-tasks/:taskId/errors-export —— 导出失败明细 CSV（任务页“可导出失败明细”） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const { taskId } = await params;
  const tasks = await sql`select id, file_name from import_tasks where id = ${taskId}`;
  if (!tasks.length) return notFound(`任务 ${taskId} 不存在`);

  const rows = await sql`
    select batch_index, row_number, field_name, raw_value, error_code, error_reason, suggestion
    from import_task_errors
    where task_id = ${taskId}
    order by batch_index, row_number
    limit 100000
  `;
  const escapeCsv = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = "批次,行号,字段,原始值(脱敏),错误码,错误原因,修复建议";
  const lines = rows.map((row) =>
    [row.batch_index, row.row_number, row.field_name, row.raw_value, row.error_code, row.error_reason, row.suggestion]
      .map(escapeCsv)
      .join(",")
  );
  const csv = `\uFEFF${header}\n${lines.join("\n")}`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="import-errors-${taskId}.csv"`
    }
  });
}
