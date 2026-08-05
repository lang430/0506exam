import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { after } from "next/server";
import { buildEnvelope, ImportEvents } from "@/lib/v4/events";
import { badRequest, batchSize, dbUnavailable, dispatcherTriggerTimeoutMs, getV4Sql } from "@/lib/v4/http";
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
    await tx`
      insert into trace_events (trace_id, task_id, unit_id, event_name, event_status, message)
      values (${traceId}, ${taskId}, '', ${ImportEvents.ImportTaskCreated}, 'ok', '任务已创建，Outbox 事件已写入')
    `;
  });

  // 响应先行：trace 记录 + 首轮调度均在后台（after()，Next.js 保证执行，不阻塞 ≤1s 响应）。
  // 调度端点会自链式（after()）续跑，直到积压清空；vercel.json 的 cron 作为宕机/冻结的兜底恢复。
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
      const token = process.env.DISPATCHER_TOKEN;
      const origin = new URL(request.url).origin;
      if (token) {
        // 首轮调度触发：await 保证首轮在 after() 保证执行的上下文中跑完，
        // 剩余批次由调度端点自链式 after() 续跑，cron 兜底宕机/冻结恢复。
        try {
          await fetch(`${origin}/api/import-dispatcher`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(dispatcherTriggerTimeoutMs())
          });
        } catch {
          /* 下一轮 cron 兜底 */
        }
      }
    } catch (error) {
      console.error("[v4] post-upload background failed", error instanceof Error ? error.message : error);
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

/**
 * GET /api/import-tasks —— 任务列表（分页 + 筛选）
 *
 * 查询参数：
 *   page        页码（默认 1）
 *   page_size   每页条数（默认 10，最大 50）
 *   status      状态筛选（pending / processing / completed / partial_success / failed）
 *   keyword     文件名模糊搜索
 *
 * 性能优化：
 * 1. 覆盖索引 import_tasks_list_cover_idx 让查询走 index-only scan，免堆回表；
 * 2. 边缘缓存：列表每 3s 轮询一次，但内容变化慢。用 s-maxage + stale-while-revalidate
 *    让 Vercel CDN 直接命中缓存（毫秒级返回），后台异步再校验，避免每次轮询都打到
 *    Supabase 事务连接池（单次往返约 600~800ms，是"列表慢"的主要来源）。
 *    任务进度等实时数据由详情页各自的轮询负责，列表 2~5s 的陈旧窗口在可接受范围。
 */
export async function GET(request: Request) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? "1"));
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get("page_size") ?? "10")));
  const status = (searchParams.get("status") ?? "").trim();
  const keyword = (searchParams.get("keyword") ?? "").trim();
  const offset = (page - 1) * pageSize;

  // 动态构建 WHERE 条件：仅在有筛选值时追加谓词，避免全表扫描
  const statusVal = status || null;
  const keywordVal = keyword ? `%${keyword}%` : null;

  try {
    // 并行查询总数与当前页数据，减少连接占用时长
    const [countResult, rows] = await Promise.all([
      sql`
        select count(*)::int as total from import_tasks
        where (${statusVal}::text is null or status = ${statusVal})
          and (${keywordVal}::text is null or file_name ilike ${keywordVal})
      `,
      sql`
        select id, file_name, status, total_rows, processed_rows, success_rows, failed_rows,
               total_batches, trace_id, degraded, created_at, completed_at
        from import_tasks
        where (${statusVal}::text is null or status = ${statusVal})
          and (${keywordVal}::text is null or file_name ilike ${keywordVal})
        order by created_at desc
        limit ${pageSize} offset ${offset}
      `
    ]);

    const total = Number(countResult[0]?.total ?? 0);

    return NextResponse.json(
      {
        tasks: rows,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.max(1, Math.ceil(total / pageSize))
        },
        filters: { status: status || null, keyword: keyword || null }
      },
      // 有筛选条件时不缓存，确保用户看到最新结果；无筛选时沿用边缘缓存
      {
        headers: (status || keyword)
          ? {}
          : { "Cache-Control": "public, s-maxage=2, stale-while-revalidate=5" }
      }
    );
  } catch (error) {
    console.error("[v4] list tasks failed", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "列表查询失败", detail: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/import-tasks —— 清空任务数据
 *
 * 查询参数：
 *   status  可选，仅删除指定状态的任务（不传则清空全部）
 *
 * 危险操作：级联删除 import_task_files、import_task_batches、import_task_errors、
 * batch_performance_log、trace_events 等关联数据。前端需二次确认。
 */
export async function DELETE(request: Request) {
  const sql = await getV4Sql();
  if (!sql) return dbUnavailable();

  const { searchParams } = new URL(request.url);
  const statusFilter = (searchParams.get("status") ?? "").trim();

  try {
    await sql.begin(async (tx) => {
      if (statusFilter) {
        // 仅删除指定状态的任务及其关联数据
        const taskIds = await tx`select id from import_tasks where status = ${statusFilter}`;
        if (!taskIds.length) return;
        const ids = taskIds.map((r) => String(r.id));
        await tx.unsafe(
          `delete from trace_events where task_id = any(array[${ids.map((_, i) => `$${i + 1}`).join(",")}])`,
          ids
        );
        await tx.unsafe(
          `delete from batch_performance_log where task_id = any(array[${ids.map((_, i) => `$${i + 1}`).join(",")}])`,
          ids
        );
        await tx.unsafe(
          `delete from import_task_errors where task_id = any(array[${ids.map((_, i) => `$${i + 1}`).join(",")}])`,
          ids
        );
        await tx.unsafe(
          `delete from import_task_batches where task_id = any(array[${ids.map((_, i) => `$${i + 1}`).join(",")}])`,
          ids
        );
        await tx.unsafe(
          `delete from import_task_files where task_id = any(array[${ids.map((_, i) => `$${i + 1}`).join(",")}])`,
          ids
        );
        await tx`delete from import_tasks where id = any(${ids})`;
      } else {
        // 清空全部：按依赖顺序截断所有关联表
        await tx`truncate table trace_events cascade`;
        await tx`truncate table batch_performance_log cascade`;
        await tx`truncate table import_task_errors cascade`;
        await tx`truncate table import_task_batches cascade`;
        await tx`truncate table import_task_files cascade`;
        await tx`truncate table import_tasks cascade`;
      }
    });

    return NextResponse.json({
      ok: true,
      message: statusFilter
        ? `已删除状态为 "${statusFilter}" 的全部任务及关联数据`
        : "已清空全部导入任务及相关数据"
    });
  } catch (error) {
    console.error("[v4] clear tasks error", error);
    return NextResponse.json(
      { ok: false, error: "清空失败，请稍后重试" },
      { status: 500 }
    );
  }
}
