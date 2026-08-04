import type postgres from "postgres";
import { parseByRule } from "@/lib/rule-engine";
import type { OrderRow, ParseRule, SheetSnapshot } from "@/lib/types";
import { ErrorCodes, errorReasonDefaults, errorSuggestions } from "@/lib/v4/error-codes";
import { buildEnvelope, ImportEvents } from "@/lib/v4/events";
import { maskRawValue } from "@/lib/v4/mask";
import { readSheetsFromBuffer } from "@/lib/v4/parse-file";
import { enqueueEvents, finalizeTaskIfNeeded, type BatchRow } from "@/lib/v4/queue";
import { recordTraceEvents } from "@/lib/v4/trace";
import { validateSlice, type RowError } from "@/lib/v4/validate";

/**
 * Import Worker：消费单个处理单元（批次）Job。
 * 流程：读原始文件 → 复用 V2 规则引擎 → 批量 SKU 校验（可降级）→
 *       批量校验 → 成功行批量 UPSERT / 失败行写错误表（单事务，幂等）→
 *       性能日志 → 原子进度累计 → 任务终态聚合。
 */

export const DEFAULT_SKU_CHECK_TIMEOUT_MS = 3000;
const UPSERT_CHUNK_SIZE = 250;
const ERROR_CHUNK_SIZE = 500;

/**
 * 实例级解析缓存：同一任务的后续批次直接复用规则引擎解析结果。
 * 全局单处理器串行消费时，同任务批次大概率落在同一函数实例；
 * 每批省去"读文件 + 全量解析"约 700ms。LRU 上限 3 条防止内存膨胀。
 */
const PARSE_CACHE_LIMIT = 3;
const parseCache = new Map<string, OrderRow[]>();

const readParseCache = (taskId: string): OrderRow[] | undefined => {
  const cached = parseCache.get(taskId);
  if (cached) {
    parseCache.delete(taskId);
    parseCache.set(taskId, cached); // 刷新 LRU 位置
  }
  return cached;
};

const writeParseCache = (taskId: string, rows: OrderRow[]): void => {
  if (parseCache.has(taskId)) parseCache.delete(taskId);
  parseCache.set(taskId, rows);
  while (parseCache.size > PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value;
    if (oldest === undefined) break;
    parseCache.delete(oldest);
  }
};

export interface BatchOutcome {
  taskId: string;
  unitId: string;
  batchIndex: number;
  successRows: number;
  failedRows: number;
  degraded: boolean;
  skipped: boolean;
  durations: {
    parse: number;
    rule: number;
    validate: number;
    insert: number;
    total: number;
  };
  taskFinalStatus?: string;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（>${ms}ms）`)), ms))
  ]);

const skuCheckTimeoutMs = (): number =>
  Number(process.env.V4_SKU_CHECK_TIMEOUT_MS || DEFAULT_SKU_CHECK_TIMEOUT_MS);

export const querySkuMasterSet = async (sql: postgres.Sql, codes: string[]): Promise<Set<string>> => {
  if (!codes.length) return new Set();
  const rows = await sql<{ sku_code: string }[]>`
    select sku_code from sku_master where sku_code = ANY(${codes})
  `;
  return new Set(rows.map((row) => row.sku_code));
};

export const queryExistingDuplicateKeys = async (sql: postgres.Sql, externalCodes: string[]): Promise<Set<string>> => {
  if (!externalCodes.length) return new Set();
  const rows = await sql<{ external_code: string; sku_code: string | null; sku_name: string | null }[]>`
    select external_code, sku_code, sku_name
    from imported_orders
    where external_code = ANY(${externalCodes})
  `;
  const keys = new Set<string>();
  for (const row of rows) {
    const skuKey = String(row.sku_code ?? "").trim() || String(row.sku_name ?? "").trim();
    keys.add(skuKey ? `${String(row.external_code).trim()}::${skuKey}` : String(row.external_code).trim());
  }
  return keys;
};

interface LoadedContext {
  task: { id: string; rule_id: string | null; trace_id: string; status: string };
  file: { file_name: string; data: Uint8Array };
  rule: ParseRule;
}

const loadContext = async (sql: postgres.Sql, batch: BatchRow): Promise<LoadedContext | { error: string; traceId: string }> => {
  const tasks = await sql`select id, rule_id, trace_id, status from import_tasks where id = ${batch.task_id}`;
  const task = tasks[0];
  if (!task) return { error: `任务 ${batch.task_id} 不存在`, traceId: "" };
  const files = await sql`select file_name, data from import_task_files where task_id = ${batch.task_id}`;
  const file = files[0];
  if (!file) return { error: "原始文件不存在", traceId: task.trace_id };
  if (!task.rule_id) return { error: "任务未关联解析规则", traceId: task.trace_id };
  const rules = await sql`select payload from parse_rules where id = ${task.rule_id}`;
  const rule = rules[0]?.payload as ParseRule | undefined;
  if (!rule) return { error: `解析规则 ${task.rule_id} 不存在`, traceId: task.trace_id };
  return { task: { id: task.id, rule_id: task.rule_id, trace_id: task.trace_id, status: task.status }, file: { file_name: file.file_name, data: file.data as Uint8Array }, rule };
};

const stableRowId = (taskId: string, row: OrderRow, rowNumber: number): string => {
  const externalCode = String(row.externalCode ?? "").trim();
  if (externalCode) {
    const skuKey = String(row.skuCode ?? "").trim() || String(row.skuName ?? "").trim() || "nosku";
    return `${externalCode}:${skuKey}:${rowNumber}`;
  }
  return `${taskId}:${rowNumber}`;
};

const upsertValidRows = async (
  tx: postgres.TransactionSql,
  taskId: string,
  validRows: { row: OrderRow; rowNumber: number }[]
): Promise<void> => {
  for (let index = 0; index < validRows.length; index += UPSERT_CHUNK_SIZE) {
    const chunk = validRows.slice(index, index + UPSERT_CHUNK_SIZE).map(({ row, rowNumber }) => {
      const id = stableRowId(taskId, row, rowNumber);
      return {
        id,
        payload: tx.json({
          id,
          externalCode: String(row.externalCode ?? ""),
          storeName: String(row.storeName ?? ""),
          receiverName: String(row.receiverName ?? ""),
          receiverPhone: String(row.receiverPhone ?? ""),
          receiverAddress: String(row.receiverAddress ?? ""),
          skuCode: String(row.skuCode ?? ""),
          skuName: String(row.skuName ?? ""),
          quantity: row.quantity ?? "",
          spec: String(row.spec ?? ""),
          remark: String(row.remark ?? ""),
          source: String(row.source ?? ""),
          submittedAt: new Date().toISOString(),
          errors: []
        } as unknown as Parameters<typeof tx.json>[0]),
        external_code: String(row.externalCode ?? ""),
        store_name: String(row.storeName ?? ""),
        receiver_name: String(row.receiverName ?? ""),
        receiver_phone: String(row.receiverPhone ?? ""),
        receiver_address: String(row.receiverAddress ?? ""),
        sku_code: String(row.skuCode ?? ""),
        sku_name: String(row.skuName ?? ""),
        quantity: Number(row.quantity) || null,
        spec: String(row.spec ?? ""),
        remark: String(row.remark ?? ""),
        source: String(row.source ?? ""),
        line_no: rowNumber
      };
    });
    await tx`
      insert into imported_orders
      ${tx(chunk, "id", "payload", "external_code", "store_name", "receiver_name", "receiver_phone", "receiver_address", "sku_code", "sku_name", "quantity", "spec", "remark", "source", "line_no")}
      on conflict (id) do update set
        payload = excluded.payload,
        external_code = excluded.external_code,
        store_name = excluded.store_name,
        receiver_name = excluded.receiver_name,
        receiver_phone = excluded.receiver_phone,
        receiver_address = excluded.receiver_address,
        sku_code = excluded.sku_code,
        sku_name = excluded.sku_name,
        quantity = excluded.quantity,
        spec = excluded.spec,
        remark = excluded.remark,
        source = excluded.source,
        line_no = excluded.line_no,
        updated_at = now()
    `;
  }
};

const insertErrors = async (
  tx: postgres.TransactionSql,
  taskId: string,
  batch: BatchRow,
  traceId: string,
  errors: RowError[]
): Promise<void> => {
  for (let index = 0; index < errors.length; index += ERROR_CHUNK_SIZE) {
    const chunk = errors.slice(index, index + ERROR_CHUNK_SIZE).map((error) => ({
      task_id: taskId,
      unit_id: batch.unit_id,
      batch_index: batch.batch_index,
      row_number: error.rowNumber,
      field_name: error.fieldName,
      raw_value: error.rawValue,
      error_code: error.errorCode,
      error_reason: error.errorReason,
      suggestion: error.suggestion,
      trace_id: traceId
    }));
    await tx`
      insert into import_task_errors
      ${tx(chunk, "task_id", "unit_id", "batch_index", "row_number", "field_name", "raw_value", "error_code", "error_reason", "suggestion", "trace_id")}
    `;
  }
};

/** 处理单个批次；可重复调用（幂等）：已完成的批次不会被重复累计 */
export const processBatch = async (sql: postgres.Sql, batch: BatchRow): Promise<BatchOutcome> => {
  const startedAt = Date.now();
  const tracePrefix = { taskId: batch.task_id, unitId: batch.unit_id };
  const context = await loadContext(sql, batch);
  if ("error" in context) {
    await sql`
      update import_task_batches set status = 'failed', completed_at = now()
      where id = ${batch.id} and status = 'processing'
    `;
    await sql`update import_tasks set error_message = ${context.error} where id = ${batch.task_id}`;
    await recordTraceEvents(sql, [{ traceId: context.traceId, ...tracePrefix, eventName: ImportEvents.ImportBatchFailed, eventStatus: "error", message: context.error }]);
    await finalizeTaskIfNeeded(sql, batch.task_id);
    return {
      taskId: batch.task_id, unitId: batch.unit_id, batchIndex: batch.batch_index,
      successRows: 0, failedRows: 0, degraded: false, skipped: false,
      durations: { parse: 0, rule: 0, validate: 0, insert: 0, total: Date.now() - startedAt }
    };
  }
  const { task, file, rule } = context;
  const traceId = task.trace_id;

  await recordTraceEvents(sql, [{ traceId, ...tracePrefix, eventName: ImportEvents.ImportBatchStarted, message: `开始处理批次 ${batch.batch_index}（第 ${batch.start_row + 1} 行起）` }]);

  // 阶段 1+2：文件解析 + 规则引擎（复用 V2 parseByRule；实例级缓存命中时跳过）
  const parseStartedAt = Date.now();
  let parsed = readParseCache(task.id);
  let parseDuration = 0;
  let ruleDuration = 0;
  if (!parsed) {
    const sheets: SheetSnapshot[] = await readSheetsFromBuffer(file.file_name, file.data);
    parseDuration = Date.now() - parseStartedAt;
    const ruleStartedAt = Date.now();
    parsed = parseByRule(sheets, rule);
    ruleDuration = Date.now() - ruleStartedAt;
    writeParseCache(task.id, parsed);
  }

  // 回填精确总行数（幂等）
  await sql`update import_tasks set total_rows = ${parsed.length} where id = ${task.id} and total_rows <> ${parsed.length}`;

  // 规则映射失败：整份文件解析结果为空 → E006
  if (parsed.length === 0) {
    const errors: RowError[] = batch.batch_index === 0 ? [{
      rowNumber: 0,
      fieldName: "rule",
      rawValue: maskRawValue("rule", file.file_name),
      errorCode: ErrorCodes.RULE_MAPPING_FAILED,
      errorReason: `${errorReasonDefaults[ErrorCodes.RULE_MAPPING_FAILED]}：规则 ${rule.name ?? rule.id} 未解析出任何 SKU 行`,
      suggestion: errorSuggestions[ErrorCodes.RULE_MAPPING_FAILED]
    }] : [];
    let committed = false;
    await sql.begin(async (tx) => {
      const locked = await tx<{ status: string }[]>`
        select status from import_task_batches where id = ${batch.id} for update
      `;
      if (locked[0]?.status !== "processing") return;
      if (errors.length) await insertErrors(tx, task.id, batch, traceId, errors);
      await tx`
        update import_task_batches set status = 'completed', completed_at = now()
        where id = ${batch.id} and status = 'processing'
      `;
      committed = true;
    });
    if (committed) await recordTraceEvents(sql, [{ traceId, ...tracePrefix, eventName: ImportEvents.ImportBatchFailed, eventStatus: "error", message: "规则解析结果为空（E006）" }]);
    if (batch.batch_index === 0) {
      await sql`update import_tasks set error_message = '规则解析结果为空，请检查解析规则（E006）' where id = ${task.id}`;
    }
    await finalizeTaskIfNeeded(sql, task.id);
    return {
      taskId: task.id, unitId: batch.unit_id, batchIndex: batch.batch_index,
      successRows: 0, failedRows: committed ? errors.length : 0, degraded: false, skipped: !committed,
      durations: { parse: parseDuration, rule: ruleDuration, validate: 0, insert: 0, total: Date.now() - startedAt }
    };
  }

  // 阶段 3：批量校验（SKU 主数据批量 IN 查询 + 3s 超时降级）
  const validateStartedAt = Date.now();
  const sliceEnd = batch.end_row < 0 ? undefined : batch.end_row;
  const slice = parsed.slice(batch.start_row, sliceEnd);
  let degraded = false;
  let skuMasterSet: Set<string> | null = null;
  const skuCodes = Array.from(new Set(slice.map((row) => String(row.skuCode ?? "").trim()).filter(Boolean)));
  if (skuCodes.length) {
    try {
      skuMasterSet = await withTimeout(querySkuMasterSet(sql, skuCodes), skuCheckTimeoutMs(), "SKU 主数据校验");
    } catch (error) {
      degraded = true;
      skuMasterSet = null;
      await recordTraceEvents(sql, [{
        traceId, ...tracePrefix, eventName: ImportEvents.ImportTaskDegraded, eventStatus: "warn",
        message: `SKU 校验降级：${error instanceof Error ? error.message : "主数据查询失败"}，本批次仅做本地格式校验`
      }]);
    }
  }
  let existingKeys = new Set<string>();
  try {
    const externalCodes = Array.from(new Set(slice.map((row) => String(row.externalCode ?? "").trim()).filter(Boolean)));
    existingKeys = await withTimeout(queryExistingDuplicateKeys(sql, externalCodes), skuCheckTimeoutMs(), "重复检测查询");
  } catch {
    existingKeys = new Set();
  }
  const { errors, validRows } = validateSlice({
    slice,
    startRowNumber: batch.start_row + 1,
    skuMasterSet,
    existingKeys
  });
  const validateDuration = Date.now() - validateStartedAt;

  // 阶段 4：批量写入 + 错误落库 + 性能日志 + 原子进度（单事务，保证幂等）
  const insertStartedAt = Date.now();
  let committed = false;
  await sql.begin(async (tx) => {
    // 先锁定处理单元并检查状态，重复投递只能快速返回，不能重复写错误/性能日志。
    const locked = await tx<{ status: string }[]>`
      select status from import_task_batches where id = ${batch.id} for update
    `;
    if (locked[0]?.status !== "processing") return;
    await upsertValidRows(tx, task.id, validRows);
    if (errors.length) await insertErrors(tx, task.id, batch, traceId, errors);
    await tx`
      insert into batch_performance_log (
        task_id, unit_id, batch_index, parse_duration_ms, rule_duration_ms,
        validate_duration_ms, insert_duration_ms, total_duration_ms,
        success_rows, failed_rows, degraded, status, trace_id
      ) values (
        ${task.id}, ${batch.unit_id}, ${batch.batch_index}, ${parseDuration}, ${ruleDuration},
        ${validateDuration}, ${Date.now() - insertStartedAt}, ${Date.now() - startedAt},
        ${validRows.length}, ${errors.length}, ${degraded}, 'completed', ${traceId}
      )
    `;
    const done = await tx`
      update import_task_batches
      set status = 'completed', completed_at = now(),
          success_rows = ${validRows.length}, failed_rows = ${errors.length},
          sku_check_skipped = ${degraded}
      where id = ${batch.id} and status = 'processing'
      returning id
    `;
    if (done.length) {
      committed = true;
      await tx`
        update import_tasks
        set processed_rows = processed_rows + ${validRows.length + errors.length},
            success_rows = success_rows + ${validRows.length},
            failed_rows = failed_rows + ${errors.length},
            degraded = degraded or ${degraded},
            status = case when status = 'pending' then 'processing' else status end
        where id = ${task.id}
      `;
    }
  });
  const insertDuration = Date.now() - insertStartedAt;

  if (committed) {
    await recordTraceEvents(sql, [
      { traceId, ...tracePrefix, eventName: "BatchValidated", message: `校验完成：${validRows.length} 行通过，${errors.length} 行错误${degraded ? "（SKU 校验已降级）" : ""}` },
      { traceId, ...tracePrefix, eventName: ImportEvents.ImportBatchSucceeded, message: `批量写入完成：${validRows.length} 行 UPSERT` }
    ]);
  }

  const finalization = await finalizeTaskIfNeeded(sql, task.id);
  if (finalization.finalized && finalization.status) {
    const finishedTasks = await sql`select success_rows, failed_rows, degraded from import_tasks where id = ${task.id}`;
    const finished = finishedTasks[0];
    const eventType = finalization.status === "completed"
      ? ImportEvents.ImportTaskCompleted
      : finalization.status === "partial_success"
        ? ImportEvents.ImportTaskPartialSuccess
        : ImportEvents.ImportBatchFailed;
    await sql.begin(async (tx) => {
      await enqueueEvents(tx, [buildEnvelope(
        eventType,
        task.id,
        traceId,
        {
          task_id: task.id,
          status: finalization.status,
          success_rows: Number(finished?.success_rows ?? 0),
          failed_rows: Number(finished?.failed_rows ?? 0),
          degraded: Boolean(finished?.degraded ?? false)
        }
      )]);
    });
    await recordTraceEvents(sql, [{
      traceId, taskId: task.id, unitId: "", eventName: eventType,
      eventStatus: finalization.status === "failed" ? "error" : "ok",
      message: `任务结束：${finalization.status}，成功 ${finished?.success_rows ?? 0} 行，失败 ${finished?.failed_rows ?? 0} 行`
    }]);
  }

  return {
    taskId: task.id,
    unitId: batch.unit_id,
    batchIndex: batch.batch_index,
    successRows: committed ? validRows.length : 0,
    failedRows: committed ? errors.length : 0,
    degraded: committed ? degraded : Boolean(batch.sku_check_skipped),
    skipped: !committed,
    durations: { parse: parseDuration, rule: ruleDuration, validate: validateDuration, insert: insertDuration, total: Date.now() - startedAt },
    taskFinalStatus: finalization.finalized ? finalization.status : undefined
  };
};
