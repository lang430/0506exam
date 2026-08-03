import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { after } from "next/server";
import { buildEnvelope, ImportEvents } from "@/lib/v4/events";
import { badRequest, batchSize, dbUnavailable, getV4Sql } from "@/lib/v4/http";
import { getBackgroundSql } from "@/lib/db";
import { enqueueEvents } from "@/lib/v4/queue";
import { isSupportedFile, preCountRows } from "@/lib/v4/parse-file";
import { recordTraceEvent, newTaskId, newTraceId } from "@/lib/v4/trace";
import { runDispatchCycle } from "@/lib/v4/dispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/import-tasks —— 上传即返回
 * 单次事务：原始文件 + import_tasks + import_task_batches + event_outbox，
 * 随后立即返回 task_id（目标 P95 ≤ 1s），解析/校验/入库全部异步执行。
 */
export async function POST(request: Request) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();

  const startedAt = Date.now();
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("请求体必须为 multipart/form-data（字段：file、ruleId）");
  }
  const file = formData.get("file");
  const ruleId = String(formData.get("ruleId") ?? "").trim();
  if (!(file instanceof File)) return badRequest("缺少文件字段 file");
  if (!ruleId) return badRequest("缺少解析规则 ruleId");
  if (!isSupportedFile(file.name)) {
    return NextResponse.json({ error: "文件格式不支持（E008）：仅支持 .xlsx / .xls / .docx / .pdf" }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  // 规则校验 + 重复上传检测合并为单次查询（压缩上传关键路径的数据库往返）
  const precheck = await sql`
    select
      (select count(*)::int from parse_rules where id = ${ruleId}) as rule_exists,
      (select id from import_tasks
        where file_sha256 = ${sha256} and created_at > now() - interval '24 hours'
        order by created_at desc limit 1) as duplicate_of,
      (select id from import_tasks
        where file_sha256 = ${sha256} and created_at > now() - interval '60 seconds'
          and status in ('pending', 'processing')
        order by created_at desc limit 1) as active_task
  `;
  if (!Number(precheck[0]?.rule_exists ?? 0)) return badRequest(`解析规则 ${ruleId} 不存在`);

  // 上传幂等：60 秒内同哈希的活跃任务直接复用（网络层请求重放不产生孪生任务）
  const activeTaskId = precheck[0]?.active_task ?? null;
  if (activeTaskId) {
    const activeTasks = await sql`select id, trace_id, total_rows, total_batches from import_tasks where id = ${activeTaskId}`;
    const active = activeTasks[0];
    if (active) {
      return NextResponse.json({
        task_id: active.id,
        trace_id: active.trace_id,
        status: "PENDING",
        total_rows: Number(active.total_rows),
        total_batches: Number(active.total_batches),
        batch_size: batchSize(),
        duplicate_of: activeTaskId,
        reused_task: true,
        upload_ms: Date.now() - startedAt
      }, { status: 202 });
    }
  }
  // 重复上传策略：同哈希 24 小时内已有任务时返回 duplicate_of 提示（仍创建新任务，
  // 数据层由稳定业务键 UPSERT 幂等兜底，见《重构假设说明》）
  const duplicateOf = precheck[0]?.duplicate_of ?? null;

  // 轻量预扫描：xlsx 用 zip 级行计数（毫秒级）；精确值由 Worker 回填
  let estimatedRows = 0;
  try {
    estimatedRows = await preCountRows(file.name, buffer);
  } catch {
    estimatedRows = 0;
  }
  const size = batchSize();
  const totalBatches = Math.max(1, Math.ceil(estimatedRows / size));

  const taskId = newTaskId();
  const traceId = newTraceId();
  const taskCreatedEvent = buildEnvelope<Record<string, unknown>>(
    ImportEvents.ImportTaskCreated,
    taskId,
    traceId,
    {
      task_id: taskId,
      file_name: file.name,
      rule_id: ruleId,
      total_rows: estimatedRows,
      total_batches: totalBatches,
      batch_size: size,
      file_sha256: sha256
    }
  );
  const batchEvents = Array.from({ length: totalBatches }, (_, index) => {
    const startRow = index * size;
    const isLast = index === totalBatches - 1;
    return buildEnvelope<Record<string, unknown>>(
      ImportEvents.ImportBatchCreated,
      taskId,
      traceId,
      {
        task_id: taskId,
        unit_id: `unit_${String(index + 1).padStart(3, "0")}`,
        batch_index: index,
        start_row: startRow,
        end_row: isLast ? -1 : startRow + size
      }
    );
  });

  // 单事务：文件 + 任务 + 批次 + Outbox（任务创建与事件写入同事务，防丢消息）
  await sql.begin(async (tx) => {
    await tx`
      insert into import_tasks (id, file_name, rule_id, status, total_rows, total_batches, file_sha256, trace_id)
      values (${taskId}, ${file.name}, ${ruleId}, 'pending', ${estimatedRows}, ${totalBatches}, ${sha256}, ${traceId})
    `;
    await tx`
      insert into import_task_files (task_id, file_name, content_type, byte_size, sha256, data)
      values (${taskId}, ${file.name}, ${file.type || "application/octet-stream"}, ${buffer.length}, ${sha256}, ${buffer})
    `;
    const batchRows = batchEvents.map((envelope) => {
      const payload = envelope.payload as { unit_id: string; batch_index: number; start_row: number; end_row: number };
      return {
        task_id: taskId,
        unit_id: payload.unit_id,
        batch_index: payload.batch_index,
        start_row: payload.start_row,
        end_row: payload.end_row
      };
    });
    await tx`
      insert into import_task_batches
      ${tx(batchRows, "task_id", "unit_id", "batch_index", "start_row", "end_row")}
    `;
    await enqueueEvents(tx, [taskCreatedEvent, ...batchEvents]);
  });

  // 响应先行：trace 记录放后台（轻量、不持租约）；调度由轮询内联/调度端点可靠推进
  const uploadMs = Date.now() - startedAt;
  after(async () => {
    try {
      const bgSql = getBackgroundSql() ?? sql;
      await recordTraceEvent(bgSql, {
        traceId,
        taskId,
        eventName: "UploadAccepted",
        message: `用户上传 ${file.name}（${buffer.length} 字节），预估 ${estimatedRows} 行，创建 ${totalBatches} 个处理单元，上传耗时 ${uploadMs}ms`
      });
    } catch (error) {
      console.error("[v4] post-upload trace failed", error instanceof Error ? error.message : error);
    }
  });

  return NextResponse.json({
    task_id: taskId,
    trace_id: traceId,
    status: "PENDING",
    total_rows: estimatedRows,
    total_batches: totalBatches,
    batch_size: size,
    duplicate_of: duplicateOf,
    upload_ms: uploadMs
  }, { status: 202 });
}

/** GET /api/import-tasks —— 任务列表（监控页/任务页用） */
export async function GET() {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();
  const rows = await sql`
    select id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
           total_batches, trace_id, degraded, created_at, completed_at
    from import_tasks
    order by created_at desc
    limit 50
  `;
  return NextResponse.json({ tasks: rows });
}
