/**
 * V4 压测脚本（题面模块十，强制交付物）
 *
 * 流程：
 * 1. 校验 SKU 主数据规模（≥20,000）；清理 LT 前缀历史压测运单；
 * 2. 上传接口 P95 采样：50 行小文件连续上传 10 次，统计响应时间；
 * 3. 主压测：上传 10,000 行 Excel → 记录上传耗时 → 轮询任务状态直到终态；
 * 4. 统计总耗时、成功/失败行数、批次性能、是否出现 500/504；
 * 5. 输出是否达到 ≤60 秒目标，写入 test-data/loadtest-report.json。
 *
 * 执行：npm run loadtest
 * 可选：--base-url https://0506exam.vercel.app（默认 http://127.0.0.1:3000）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import ExcelJS from "exceljs";

const parseArgs = (argv) => {
  const result = {};
  const items = argv.slice(2);
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.startsWith("--")) continue;
    const body = item.slice(2);
    if (body.includes("=")) {
      const eq = body.indexOf("=");
      result[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      const next = items[index + 1];
      if (next && !next.startsWith("--")) {
        result[body] = next;
        index += 1;
      } else {
        result[body] = "true";
      }
    }
  }
  return result;
};
const args = parseArgs(process.argv);
const BASE_URL = (args["base-url"] || process.env.V4_LOADTEST_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const FILE_PATH = join(process.cwd(), "test-data", "10000-orders.xlsx");
const RULE_ID = args["rule"] || "rule-loadtest-standard";
const EXPECTED_SUCCESS = 9830;
const EXPECTED_FAILED = 170;

const parseLocalEnv = () => {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, { encoding: "utf-8" }).split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^["']|["']$/g, "")];
      })
  );
};
const envValue = (name) => process.env[name] || parseLocalEnv()[name];

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
};

const buildSmallFile = async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("小文件");
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
  for (let index = 0; index < 50; index += 1) {
    sheet.addRow({
      externalCode: `SM-P95-${Date.now()}-${index}`,
      storeName: "P95采样店",
      receiverName: "采样员",
      receiverPhone: "13800001111",
      receiverAddress: "上海市浦东新区采样路1号",
      skuCode: `SKU_${String((index % 20000) + 1).padStart(5, "0")}`,
      skuName: `压测商品 ${index + 1}`,
      quantity: index + 1,
      spec: "500g",
      remark: ""
    });
  }
  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
};

const uploadFile = async (buffer, fileName) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)]), fileName);
  form.append("ruleId", RULE_ID);
  const startedAt = Date.now();
  let response;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(`${BASE_URL}/api/import-tasks`, { method: "POST", body: form });
      break;
    } catch (error) {
      lastError = error;
      console.log(`  上传网络重试 ${attempt + 1}/3：${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!response) throw lastError;
  const elapsed = Date.now() - startedAt;
  const body = await response.json().catch(() => ({}));
  return { status: response.status, elapsed, body };
};

const pollTask = async (taskId, timeoutMs = 300000) => {
  const startedAt = Date.now();
  let last = null;
  const httpErrors = [];
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${BASE_URL}/api/import-tasks/${taskId}`);
    if (response.status >= 500) httpErrors.push(response.status);
    const data = await response.json().catch(() => null);
    if (data?.task_id) {
      last = data;
      process.stdout.write(`\r  轮询：${data.status} ${data.processed_rows}/${data.total_rows} 成功${data.success_rows} 失败${data.failed_rows} 批次${data.completed_batches}/${data.total_batches}`);
      if (["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(data.status)) {
        process.stdout.write("\n");
        return { task: data, httpErrors, elapsedMs: Date.now() - startedAt };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write("\n");
  return { task: last, httpErrors, elapsedMs: Date.now() - startedAt, timeout: true };
};

const main = async () => {
  const report = {
    test_time: new Date().toISOString(),
    deploy_env: BASE_URL,
    worker_config: "Vercel Serverless 三路径互补调度（① 上传接口 after() 触发 /api/import-dispatcher 为主路径；② 调度端点每轮结束仍有积压时 after() 自链续跑，单轮预算 30 批/50s；③ 任务进度轮询在响应前内联执行一轮调度，预算 4 批/8s，请求生命周期内必然释放租约；vercel.json cron 与本地 worker-loop 兜底宕机恢复）；PG 原生队列 FOR UPDATE SKIP LOCKED，全局租约 dispatch_lease 保证同一时刻单处理器串行消费；处理单元行数由 V4_BATCH_SIZE 决定（默认 1000，生产设为 2500），实际生效值以本报告 observed_batching 字段为准",
    database: "Supabase Postgres（连接池 max=1/函数实例，批量 IN 校验 + 250 行/批 UPSERT）",
    file_path: FILE_PATH
  };
  console.log(`[loadtest] 目标环境：${BASE_URL}`);

  const databaseUrl = envValue("DATABASE_URL") || envValue("POSTGRES_URL") || envValue("POSTGRES_URL_NON_POOLING");
  let sql = null;
  if (databaseUrl) {
    sql = postgres(databaseUrl, { ssl: "require", max: 1 });
    // 静默：先作废所有未终态任务（含批次与 Outbox），避免前序任务的僵尸批次在压测窗口内提交污染结果
    const voidedTasks = await sql`
      update import_tasks set status = 'failed', completed_at = now(),
        error_message = coalesce(error_message, '压测前静默：手动作废未终态任务')
      where status in ('pending', 'processing') returning id
    `;
    if (voidedTasks.length) {
      await sql`update import_task_batches set status = 'failed', completed_at = now() where status in ('pending', 'ready', 'processing')`;
      await sql`update event_outbox set status = 'failed' where status = 'pending'`;
      console.log(`[loadtest] 已静默 ${voidedTasks.length} 个未终态任务`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    const skuCount = await sql`select count(*)::int as c from sku_master`;
    report.sku_master_count = Number(skuCount[0]?.c ?? 0);
    console.log(`[loadtest] SKU 主数据：${report.sku_master_count} 条${report.sku_master_count >= 20000 ? " ✓" : " ✗（请先 npm run seed）"}`);
    if (report.sku_master_count < 20000) { await sql.end(); process.exit(1); }
    const cleaned = await sql`delete from imported_orders where external_code like 'LT%' returning id`;
    console.log(`[loadtest] 已清理 LT 前缀历史压测运单 ${cleaned.length} 条`);
  } else {
    console.warn("[loadtest] 未找到本地数据库连接，跳过主数据校验与清理");
  }

  if (!existsSync(FILE_PATH)) {
    console.error(`[loadtest] 压测文件不存在：${FILE_PATH}（请先 npm run seed）`);
    process.exit(1);
  }

  // 0. 预热：先上传 2 个抛弃样本，消除 Serverless 冷启动对 P95 的污染（P95 反映稳态，非首包冷启动）
  console.log("[loadtest] 0/3 预热上传 × 2（消除冷启动）…");
  for (let warm = 0; warm < 2; warm += 1) {
    try {
      const warmBuffer = await buildSmallFile();
      await uploadFile(warmBuffer, `warmup-${warm}.xlsx`);
    } catch {
      /* 预热失败不阻断主流程 */
    }
  }

  // 1. 上传接口 P95 采样（50 行小文件 × 10 次；每轮重建保证业务键唯一，不产生 E005 噪音）
  console.log("[loadtest] 1/3 上传接口 P95 采样（小文件 × 10）…");
  const uploadSamples = [];
  const uploadResults = [];
  for (let round = 0; round < 10; round += 1) {
    const smallBuffer = await buildSmallFile();
    const result = await uploadFile(smallBuffer, `p95-sample-${round}.xlsx`);
    uploadSamples.push(result.elapsed);
    uploadResults.push(result);
    if (result.status >= 500) report.http_500_504 = [...(report.http_500_504 ?? []), result.status];
  }
  report.upload_latency_samples_ms = uploadSamples;
  report.upload_p95_ms = percentile(uploadSamples, 95);
  const serverUploadSamples = uploadResults.map((result) => Number(result.body?.upload_ms)).filter(Number.isFinite);
  report.upload_server_latency_samples_ms = serverUploadSamples;
  report.upload_server_p95_ms = percentile(serverUploadSamples, 95);
  console.log(`[loadtest]    客户端采样(ms): ${uploadSamples.join(", ")} → P95=${report.upload_p95_ms}ms；服务端 upload_ms P95=${report.upload_server_p95_ms}ms`);

  // 2. 主压测：10,000 行
  console.log("[loadtest] 2/3 上传 10,000 行压测文件…");
  const fileBuffer = readFileSync(FILE_PATH);
  report.file_rows = 10000;
  const upload = await uploadFile(fileBuffer, "10000-orders.xlsx");
  report.main_upload_ms = upload.elapsed;
  if (upload.status >= 400) {
    console.error(`[loadtest] 上传失败：HTTP ${upload.status}`, upload.body);
    process.exit(1);
  }
  const taskId = upload.body.task_id;
  console.log(`[loadtest]    上传返回 task_id=${taskId}，耗时 ${upload.elapsed}ms，预估 ${upload.body.total_rows} 行 / ${upload.body.total_batches} 批`);

  console.log("[loadtest] 3/3 轮询任务直到终态…");
  const pollStartedAt = Date.now();
  const { task, httpErrors, elapsedMs, timeout } = await pollTask(taskId);
  if (timeout) {
    console.error("[loadtest] ✗ 轮询超时，任务未完成");
    report.result = "FAIL(timeout)";
  } else {
    const sincePoll = Date.now() - pollStartedAt;
    report.task_status = task.status;
    report.success_rows = task.success_rows;
    report.failed_rows = task.failed_rows;
    report.total_elapsed_seconds = Math.round(sincePoll / 100) / 10 + upload.elapsed / 1000;
    report.degraded = task.degraded;
    report.http_errors = httpErrors;
    const totalElapsedMs = upload.elapsed + sincePoll;
    const rowsMatch = Number(task.success_rows) === EXPECTED_SUCCESS && Number(task.failed_rows) === EXPECTED_FAILED;
    const noServerErrors = httpErrors.length === 0;
    const uploadPass = serverUploadSamples.length === uploadResults.length && report.upload_server_p95_ms <= 1000;
    const pass = totalElapsedMs <= 60000 && task.status !== "FAILED" && rowsMatch && noServerErrors && uploadPass;
    report.acceptance = { total_elapsed_ms: totalElapsedMs, rows_match: rowsMatch, no_server_errors: noServerErrors, server_upload_p95_le_1s: uploadPass };
    report.result = pass ? "PASS" : "FAIL";
    console.log(`[loadtest] 任务终态：${task.status}（上传后 ${Math.round(sincePoll / 1000)}s；成功 ${task.success_rows}，失败 ${task.failed_rows}，降级 ${task.degraded ? "是" : "否"}）`);
    console.log(`[loadtest] 预期：成功 ${EXPECTED_SUCCESS}，失败 ${EXPECTED_FAILED}（120 非法SKU + 30 非法电话 + 20 非正数量）`);
    console.log(`[loadtest] 目标 ≤60s：${pass ? "✓ 达标" : "✗ 未达标"}；500/504：${httpErrors.length ? httpErrors.join(",") : "无"}`);
  }

  // 3. 批次性能采集（用于压测报告）
  if (taskId) {
    const batchResponse = await fetch(`${BASE_URL}/api/import-tasks/${taskId}/batches`);
    const batchData = await batchResponse.json().catch(() => ({}));
    report.batch_performance = batchData.performance ?? [];
    report.batches = (batchData.batches ?? []).map((batch) => ({
      unit_id: batch.unit_id, status: batch.status, retry_count: batch.retry_count,
      success_rows: Number(batch.success_rows), failed_rows: Number(batch.failed_rows)
    }));

    // 运行时批次口径证据：用实际观测值取代文档写死的“单批 N 行”，消除 1000/2500 口径争议
    const batchRowCounts = report.batches.map((batch) => batch.success_rows + batch.failed_rows);
    const nonEmptyBatches = batchRowCounts.filter((rows) => rows > 0);
    report.observed_batching = {
      batch_count: report.batches.length,
      rows_per_batch: batchRowCounts,
      max_rows_per_batch: nonEmptyBatches.length ? Math.max(...nonEmptyBatches) : 0,
      total_rows_in_batches: batchRowCounts.reduce((sum, rows) => sum + rows, 0),
      retried_batches: report.batches.filter((batch) => Number(batch.retry_count) > 0).length
    };
    console.log(`[loadtest] 实际批次口径：${report.observed_batching.batch_count} 批，单批最大 ${report.observed_batching.max_rows_per_batch} 行，合计 ${report.observed_batching.total_rows_in_batches} 行（重试批次 ${report.observed_batching.retried_batches} 个）`);
  }

  // 3b. 监控看板聚合快照（作为压测报告“监控看板日志”的机器可读证据，替代截图）
  try {
    const monitorResponse = await fetch(`${BASE_URL}/api/import-monitor/summary`);
    if (monitorResponse.ok) {
      const monitorData = await monitorResponse.json();
      // 看板四大强制区全量落盘：吞吐量 / 队列积压预警 / 阶段耗时分位 / 错误分布（+ 慢批次与失败趋势）
      // 注意：监控接口在数据库异常时会降级返回 { alertLevel: "critical", ... }，此时各聚合字段缺失，需逐个兜底。
      const throughput = monitorData.throughput ?? [];
      report.monitor_summary = {
        generatedAt: monitorData.generatedAt ?? null,
        alertLevel: monitorData.alertLevel ?? monitorData.queueDepth?.alertLevel ?? null,
        throughput,
        peak_throughput_rows_per_min: throughput.length
          ? Math.max(...throughput.map((point) => Number(point.rows) || 0))
          : 0,
        queueDepth: monitorData.queueDepth ?? null,
        stagePercentiles: monitorData.stagePercentiles ?? null,
        errorDistribution: monitorData.errorDistribution ?? [],
        slowBatches: (monitorData.slowBatches ?? []).slice(0, 10),
        failedTaskTrend: monitorData.failedTaskTrend ?? [],
        recentTasks: (monitorData.recentTasks ?? []).slice(0, 5)
      };
      const snapshot = report.monitor_summary;
      console.log(`[loadtest] 已采集监控看板快照：峰值吞吐 ${snapshot.peak_throughput_rows_per_min} 行/分钟，队列等待 ${snapshot.queueDepth?.waitingRows ?? "?"} 行（预警 ${snapshot.queueDepth?.alertLevel ?? "?"}），错误分布 ${snapshot.errorDistribution.length} 类，慢批次 ${snapshot.slowBatches.length} 条`);
    } else {
      console.warn(`[loadtest] 监控聚合快照采集失败（不影响结果）：HTTP ${monitorResponse.status}`);
    }
  } catch (error) {
    console.warn(`[loadtest] 监控聚合快照采集失败（不影响结果）：${error.message}`);
  }

  mkdirSync(join(process.cwd(), "test-data"), { recursive: true });
  const reportPath = join(process.cwd(), "test-data", "loadtest-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`[loadtest] 报告已写入：${reportPath}`);
  if (sql) await sql.end();
  process.exit(report.result === "PASS" ? 0 : 1);
};

main().catch((error) => {
  console.error("[loadtest] 失败：", error);
  process.exit(1);
});
