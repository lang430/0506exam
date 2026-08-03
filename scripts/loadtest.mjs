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
  const response = await fetch(`${BASE_URL}/api/import-tasks`, { method: "POST", body: form });
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
    worker_config: "Vercel Serverless（after() 进程内调度 + 自链式 Dispatcher，批次顺序消费，单批 1000 行）",
    database: "Supabase Postgres（连接池 max=1/函数实例，批量 IN 校验 + 250 行/批 UPSERT）",
    file_path: FILE_PATH
  };
  console.log(`[loadtest] 目标环境：${BASE_URL}`);

  const databaseUrl = envValue("DATABASE_URL") || envValue("POSTGRES_URL") || envValue("POSTGRES_URL_NON_POOLING");
  let sql = null;
  if (databaseUrl) {
    sql = postgres(databaseUrl, { ssl: "require", max: 1 });
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

  // 1. 上传接口 P95 采样（50 行小文件 × 10 次）
  console.log("[loadtest] 1/3 上传接口 P95 采样（小文件 × 10）…");
  const smallBuffer = await buildSmallFile();
  const uploadSamples = [];
  for (let round = 0; round < 10; round += 1) {
    const result = await uploadFile(smallBuffer, `p95-sample-${round}.xlsx`);
    uploadSamples.push(result.elapsed);
    if (result.status >= 500) report.http_500_504 = [...(report.http_500_504 ?? []), result.status];
  }
  report.upload_latency_samples_ms = uploadSamples;
  report.upload_p95_ms = percentile(uploadSamples, 95);
  console.log(`[loadtest]    采样(ms): ${uploadSamples.join(", ")} → P95=${report.upload_p95_ms}ms ${report.upload_p95_ms <= 1000 ? "✓ ≤1s" : "✗ >1s"}`);

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
    const totalElapsedMs = (upload.body.upload_ms ?? upload.elapsed) + elapsedMs;
    const sincePoll = Date.now() - pollStartedAt;
    report.task_status = task.status;
    report.success_rows = task.success_rows;
    report.failed_rows = task.failed_rows;
    report.total_elapsed_seconds = Math.round(sincePoll / 100) / 10 + upload.elapsed / 1000;
    report.degraded = task.degraded;
    report.http_errors = httpErrors;
    const pass = sincePoll <= 60000 && task.status !== "FAILED";
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
