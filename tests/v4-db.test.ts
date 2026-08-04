import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import ExcelJS from "exceljs";
import { getDatabaseUrl } from "@/lib/db";
import { ensureV4Schema } from "@/lib/v4/schema";
import { dispatchOutbox, claimReadyBatches, enqueueEvents, finalizeTaskIfNeeded } from "@/lib/v4/queue";
import { processBatch, querySkuMasterSet } from "@/lib/v4/worker";
import { buildEnvelope, ImportEvents } from "@/lib/v4/events";
import type { BatchRow } from "@/lib/v4/queue";

/**
 * V4 数据库集成测试（题面 10.1 自动化测试场景 2~11）
 * 需要 DATABASE_URL / .env.local；CI 无库时整组跳过。
 */

const databaseUrl = getDatabaseUrl();
const RUN = Boolean(databaseUrl);
const describeDb = RUN ? describe : describe.skip;

const RULE_ID = "rule-v4test";
const TASK_PREFIX = "task_v4test_";
const TRACE_PREFIX = "trace_v4test_";

let sql: postgres.Sql;

const buildTestExcel = async (): Promise<Buffer> => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("v4test");
  sheet.columns = [
    { header: "外部编码", key: "externalCode" },
    { header: "收货门店", key: "storeName" },
    { header: "收件人姓名", key: "receiverName" },
    { header: "收件人电话", key: "receiverPhone" },
    { header: "收件人地址", key: "receiverAddress" },
    { header: "SKU物品编码", key: "skuCode" },
    { header: "SKU物品名称", key: "skuName" },
    { header: "SKU发货数量", key: "quantity" },
    { header: "SKU规格型号", key: "spec" },
    { header: "备注", key: "remark" }
  ];
  const base = { storeName: "V4测试店", receiverName: "测试员", receiverPhone: "13900001111", receiverAddress: "测试市测试路1号", spec: "500g", remark: "" };
  sheet.addRow({ externalCode: "V4T-1", ...base, skuCode: "SKU_00001", skuName: "商品1", quantity: 2 });
  sheet.addRow({ externalCode: "V4T-2", ...base, skuCode: "SKU_00002", skuName: "商品2", quantity: 5 });
  sheet.addRow({ externalCode: "V4T-3", ...base, skuCode: "SKU_00003", skuName: "商品3", quantity: 7 });
  sheet.addRow({ externalCode: "V4T-4", ...base, skuCode: "SKU_V4TEST_BAD", skuName: "非法SKU", quantity: 1 });
  sheet.addRow({ externalCode: "V4T-5", ...base, skuCode: "SKU_00001", skuName: "零数量", quantity: 0 });
  sheet.addRow({ externalCode: "V4T-6", ...base, receiverPhone: "999", skuCode: "SKU_00002", skuName: "坏电话", quantity: 3 });
  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const seedRule = async (): Promise<void> => {
  const rule = {
    id: RULE_ID,
    name: "V4测试规则",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 1,
    dataStartRow: 2,
    mappings: {
      externalCode: { source: "header", header: "外部编码" },
      storeName: { source: "header", header: "收货门店" },
      receiverName: { source: "header", header: "收件人姓名" },
      receiverPhone: { source: "header", header: "收件人电话" },
      receiverAddress: { source: "header", header: "收件人地址" },
      skuCode: { source: "header", header: "SKU物品编码" },
      skuName: { source: "header", header: "SKU物品名称" },
      quantity: { source: "header", header: "SKU发货数量" },
      spec: { source: "header", header: "SKU规格型号" },
      remark: { source: "header", header: "备注" }
    }
  };
  await sql`
    insert into parse_rules (id, payload) values (${RULE_ID}, ${sql.json(rule as never)})
    on conflict (id) do update set payload = excluded.payload, updated_at = now()
  `;
};

/** 模拟上传接口的单事务写入：任务 + 文件 + 批次 + Outbox */
const createTaskInOneTransaction = async (taskId: string, traceId: string, fileBuffer: Buffer): Promise<void> => {
  const envelopeBatch = buildEnvelope(ImportEvents.ImportBatchCreated, taskId, traceId, {
    task_id: taskId, unit_id: "unit_001", batch_index: 0, start_row: 0, end_row: -1
  });
  const envelopeTask = buildEnvelope(ImportEvents.ImportTaskCreated, taskId, traceId, {
    task_id: taskId, file_name: "v4test.xlsx", rule_id: RULE_ID, total_rows: 6, total_batches: 1, batch_size: 1000, file_sha256: "v4test"
  });
  await sql.begin(async (tx) => {
    await tx`insert into import_tasks (id, file_name, rule_id, status, total_rows, total_batches, file_sha256, trace_id)
      values (${taskId}, 'v4test.xlsx', ${RULE_ID}, 'pending', 6, 1, 'v4test', ${traceId})`;
    await tx`insert into import_task_files (task_id, file_name, content_type, byte_size, sha256, data)
      values (${taskId}, 'v4test.xlsx', 'application/octet-stream', ${fileBuffer.length}, 'v4test', ${fileBuffer})`;
    await tx`insert into import_task_batches (task_id, unit_id, batch_index, start_row, end_row)
      values (${taskId}, 'unit_001', 0, 0, -1)`;
    await enqueueEvents(tx, [envelopeTask, envelopeBatch]);
  });
};

const cleanupTestArtifacts = async (): Promise<void> => {
  await sql`delete from batch_performance_log where task_id like ${`${TASK_PREFIX}%`}`;
  await sql`delete from trace_events where task_id like ${`${TASK_PREFIX}%`} or trace_id like ${`${TRACE_PREFIX}%`}`;
  await sql`delete from event_outbox where aggregate_id like ${`${TASK_PREFIX}%`}`;
  await sql`delete from import_tasks where id like ${`${TASK_PREFIX}%`}`;
  await sql`delete from imported_orders where external_code like 'V4T-%'`;
};

describeDb("V4 数据库集成测试", () => {
  beforeAll(async () => {
    sql = postgres(databaseUrl as string, { ssl: "require", max: 1, prepare: false });
    await ensureV4Schema(sql);
    await cleanupTestArtifacts();
    await seedRule();
  });

  afterAll(async () => {
    await cleanupTestArtifacts();
    await sql.end();
  });

  it("场景2：任务创建与 Outbox 写入同事务，event_id 幂等去重", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    const traceId = `${TRACE_PREFIX}atomic`;
    const buffer = await buildTestExcel();
    await createTaskInOneTransaction(taskId, traceId, buffer);
    const tasks = await sql`select id from import_tasks where id = ${taskId}`;
    const outbox = await sql`select count(*)::int as c from event_outbox where aggregate_id = ${taskId}`;
    const batches = await sql`select count(*)::int as c from import_task_batches where task_id = ${taskId}`;
    expect(tasks.length).toBe(1);
    expect(Number(outbox[0].c)).toBe(2);
    expect(Number(batches[0].c)).toBe(1);
    // 重复投递同一事件（相同 event_id）不会产生重复记录（on conflict do nothing）
    const stored = await sql`select payload from event_outbox where aggregate_id = ${taskId} and event_type = 'ImportBatchCreated' limit 1`;
    const storedEnvelope = (typeof stored[0].payload === "string" ? JSON.parse(stored[0].payload) : stored[0].payload) as Parameters<typeof enqueueEvents>[1][number];
    await sql.begin(async (tx) => {
      await enqueueEvents(tx, [storedEnvelope]);
    });
    const outboxAgain = await sql`select count(*)::int as c from event_outbox where aggregate_id = ${taskId} and event_type = 'ImportBatchCreated'`;
    expect(Number(outboxAgain[0].c)).toBe(1);
  });

  it("场景3：Dispatcher 可恢复投递（宕机后 Outbox 继续生效）", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    // 模拟“任务已创建但消息未投递”：重置为 pending
    await sql`update event_outbox set status = 'pending', next_retry_at = now() where aggregate_id = ${taskId}`;
    await sql`update import_task_batches set status = 'pending' where task_id = ${taskId}`;
    const result = await dispatchOutbox(sql);
    expect(result.sent).toBeGreaterThanOrEqual(2);
    const batches = await sql`select status from import_task_batches where task_id = ${taskId}`;
    expect(batches[0].status).toBe("ready");
    const outbox = await sql`select status from event_outbox where aggregate_id = ${taskId} and event_type = 'ImportBatchCreated'`;
    expect(outbox[0].status).toBe("sent");
  });

  it("场景3b：卡死批次重试超限后，任务聚合为 failed", async () => {
    const taskId = `${TASK_PREFIX}deadletter`;
    const traceId = `${TRACE_PREFIX}deadletter`;
    const buffer = await buildTestExcel();
    await createTaskInOneTransaction(taskId, traceId, buffer);
    await sql`update import_task_batches
      set status = 'processing', retry_count = 3, locked_at = now() - interval '1 hour'
      where task_id = ${taskId}`;
    await sql`update import_tasks set status = 'processing' where id = ${taskId}`;

    const { recoverStuckBatches } = await import("@/lib/v4/queue");
    const result = await recoverStuckBatches(sql);
    expect(result.deadLettered).toBe(1);

    const task = await sql`select status, processed_rows, success_rows, failed_rows, completed_at
      from import_tasks where id = ${taskId}`;
    expect(task[0].status).toBe("failed");
    expect(Number(task[0].processed_rows)).toBe(0);
    expect(Number(task[0].success_rows)).toBe(0);
    expect(Number(task[0].failed_rows)).toBe(0);
    expect(task[0].completed_at).toBeTruthy();
  });

  it("场景4+7+8：Worker 处理成功；部分行失败不阻断成功行入库；错误按行记录", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    const claimed = await claimReadyBatches(sql, 1, taskId);
    expect(claimed.length).toBe(1);
    expect(claimed[0].task_id).toBe(taskId);
    const outcome = await processBatch(sql, claimed[0]);
    expect(outcome.successRows).toBe(3);
    expect(outcome.failedRows).toBe(3);
    const orders = await sql`select count(*)::int as c from imported_orders where external_code like 'V4T-%'`;
    expect(Number(orders[0].c)).toBe(3); // 成功行已入库
    const errors = await sql`select row_number, error_code, field_name, raw_value from import_task_errors where task_id = ${taskId} order by row_number`;
    expect(errors.length).toBe(3);
    const codes = errors.map((e) => e.error_code).sort();
    expect(codes).toEqual(["E001", "E003", "E004"]);
    const phoneError = errors.find((e) => e.error_code === "E003");
    expect(phoneError?.raw_value).not.toContain("999"); // 原始值脱敏
    const skuError = errors.find((e) => e.error_code === "E001");
    expect(skuError?.raw_value).toBe("SKU_V4TEST_BAD");
  });

  it("场景5：重复消费幂等——已完成批次不再被认领，强制重放不重复累计", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    const readyAgain = await claimReadyBatches(sql, 1, taskId);
    expect(readyAgain.length).toBe(0); // 已完成批次不会再次入队认领
    const before = await sql`select processed_rows, success_rows from import_tasks where id = ${taskId}`;
    const ordersBefore = await sql`select count(*)::int as c from imported_orders where external_code like 'V4T-%'`;
    const errorsBefore = await sql`select count(*)::int as c from import_task_errors where task_id = ${taskId}`;
    const performanceBefore = await sql`select count(*)::int as c from batch_performance_log where task_id = ${taskId}`;
    const batchRows = await sql`select * from import_task_batches where task_id = ${taskId}`;
    const batch = batchRows[0] as unknown as BatchRow;
    batch.status = "processing";
    const outcome = await processBatch(sql, batch); // 模拟消息重复投递
    expect(outcome.skipped).toBe(true);
    const after = await sql`select processed_rows, success_rows from import_tasks where id = ${taskId}`;
    const ordersAfter = await sql`select count(*)::int as c from imported_orders where external_code like 'V4T-%'`;
    expect(String(after[0].processed_rows)).toBe(String(before[0].processed_rows)); // 进度不重复累计
    expect(Number(ordersAfter[0].c)).toBe(Number(ordersBefore[0].c)); // 运单不重复写入
    const errorsAfter = await sql`select count(*)::int as c from import_task_errors where task_id = ${taskId}`;
    const performanceAfter = await sql`select count(*)::int as c from batch_performance_log where task_id = ${taskId}`;
    expect(Number(errorsAfter[0].c)).toBe(Number(errorsBefore[0].c));
    expect(Number(performanceAfter[0].c)).toBe(Number(performanceBefore[0].c));
    await sql`update import_task_batches set status = 'completed' where task_id = ${taskId}`;
  });

  it("场景6：SKU 批量校验（单次 IN 查询）", async () => {
    const set = await querySkuMasterSet(sql, ["SKU_00001", "SKU_00002", "SKU_NOT_EXIST_X"]);
    expect(set.has("SKU_00001")).toBe(true);
    expect(set.has("SKU_00002")).toBe(true);
    expect(set.has("SKU_NOT_EXIST_X")).toBe(false);
  });

  it("场景9：任务最终状态聚合为 partial_success，且聚合幂等", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    // Worker 处理完成后已自动聚合终态
    const task = await sql`select status, completed_at from import_tasks where id = ${taskId}`;
    expect(task[0].status).toBe("partial_success");
    expect(task[0].completed_at).toBeTruthy();
    // 重复聚合保持幂等：不再重复写入，状态稳定
    const result = await finalizeTaskIfNeeded(sql, taskId);
    expect(result.finalized).toBe(false);
    const taskAgain = await sql`select status from import_tasks where id = ${taskId}`;
    expect(taskAgain[0].status).toBe("partial_success");
  });

  it("场景10：SKU 校验超时触发降级，跳过 E001 且任务标记 degraded", async () => {
    const taskId = `${TASK_PREFIX}degraded`;
    const traceId = `${TRACE_PREFIX}degraded`;
    const buffer = await buildTestExcel();
    await createTaskInOneTransaction(taskId, traceId, buffer);
    await sql`update event_outbox set status='sent' where aggregate_id = ${taskId}`;
    await sql`update import_task_batches set status='ready' where task_id = ${taskId}`;
    const originalTimeout = process.env.V4_SKU_CHECK_TIMEOUT_MS;
    process.env.V4_SKU_CHECK_TIMEOUT_MS = "1"; // 1ms 必然超时 → 降级
    try {
      const claimed = await claimReadyBatches(sql, 1, taskId);
      const outcome = await processBatch(sql, claimed[0]);
      expect(outcome.degraded).toBe(true);
      expect(outcome.failedRows).toBe(2); // 仅电话/数量错误；SKU 校验被跳过
      const task = await sql`select degraded from import_tasks where id = ${taskId}`;
      expect(task[0].degraded).toBe(true);
      const batch = await sql`select sku_check_skipped from import_task_batches where task_id = ${taskId}`;
      expect(batch[0].sku_check_skipped).toBe(true);
      const degradedEvents = await sql`select count(*)::int as c from trace_events where task_id = ${taskId} and event_name = 'ImportTaskDegraded'`;
      expect(Number(degradedEvents[0].c)).toBeGreaterThanOrEqual(1);
    } finally {
      if (originalTimeout === undefined) delete process.env.V4_SKU_CHECK_TIMEOUT_MS;
      else process.env.V4_SKU_CHECK_TIMEOUT_MS = originalTimeout;
    }
  });

  it("场景11：Trace 时间线事件生成", async () => {
    const taskId = `${TASK_PREFIX}atomic`;
    const events = await sql`select event_name, event_status from trace_events where task_id = ${taskId} order by occurred_at`;
    expect(events.length).toBeGreaterThanOrEqual(2);
    const names = events.map((e) => e.event_name);
    expect(names).toContain(ImportEvents.ImportBatchStarted);
    expect(names).toContain(ImportEvents.ImportBatchSucceeded);
  });
});
