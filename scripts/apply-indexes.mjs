#!/usr/bin/env node
/**
 * 将 database-v4.sql 中「查询性能索引补充」段的索引应用到目标库。
 *
 * 用法：
 *   node scripts/apply-indexes.mjs            # 应用索引 + 验证
 *   node scripts/apply-indexes.mjs --dry-run  # 仅打印将执行的语句
 *
 * 说明：
 * - 全部使用 create index if not exists，可重复执行（幂等）。
 * - DDL 优先走 POSTGRES_URL_NON_POOLING（直连），避免连接池代理对 DDL 的限制。
 * - 建索引后自动 ANALYZE，让查询计划器立即用上新索引。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/** 极简 .env 解析：只取 KEY=VALUE，支持首尾引号 */
const loadEnvFile = (file) => {
  const full = path.join(projectRoot, file);
  if (!fs.existsSync(full)) return;
  for (const rawLine of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
};

[".env.local", ".env"].forEach(loadEnvFile);

const databaseUrl =
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("[apply-indexes] 未找到数据库连接串（POSTGRES_URL_NON_POOLING / POSTGRES_URL / DATABASE_URL）");
  process.exit(1);
}

/** 本次要应用的索引：与 database-v4.sql 及 lib/v4/schema.ts 保持一致 */
const INDEXES = [
  {
    name: "imported_orders_created_at_idx",
    table: "imported_orders",
    reason: "监控实时吞吐按 created_at 范围过滤，此前全表扫描最大表",
    ddl: `create index if not exists imported_orders_created_at_idx
            on public.imported_orders (created_at desc)`
  },
  {
    name: "import_task_errors_created_at_idx",
    table: "import_task_errors",
    reason: "监控错误分布 24h 范围过滤，原 error_code 单列索引不服务时间过滤",
    ddl: `create index if not exists import_task_errors_created_at_idx
            on public.import_task_errors (created_at desc)`
  },
  {
    name: "import_task_errors_task_row_idx",
    table: "import_task_errors",
    reason: "错误明细分页 order by row_number，消除额外 Sort",
    ddl: `create index if not exists import_task_errors_task_row_idx
            on public.import_task_errors (task_id, row_number)`
  },
  {
    name: "import_tasks_created_at_idx",
    table: "import_tasks",
    reason: "任务列表/recentTasks 全局按时间倒序，原 (status, created_at) 前导列错位",
    ddl: `create index if not exists import_tasks_created_at_idx
            on public.import_tasks (created_at desc)`
  },
  {
    name: "batch_performance_log_created_duration_idx",
    table: "batch_performance_log",
    reason: "慢批次 TOP10 按 total_duration_ms 排序",
    ddl: `create index if not exists batch_performance_log_created_duration_idx
            on public.batch_performance_log (created_at desc, total_duration_ms desc)`
  },
  {
    name: "import_task_batches_task_status_idx",
    table: "import_task_batches",
    reason: "任务详情批次聚合 where task_id，原 (status, task_id) 前导列错位",
    ddl: `create index if not exists import_task_batches_task_status_idx
            on public.import_task_batches (task_id, status)`
  }
];

const dryRun = process.argv.includes("--dry-run");

if (dryRun) {
  console.log("[apply-indexes] DRY RUN，将执行以下语句：\n");
  INDEXES.forEach((i, n) => console.log(`-- ${n + 1}. ${i.reason}\n${i.ddl.replace(/\s+/g, " ")};\n`));
  process.exit(0);
}

const sql = postgres(databaseUrl, {
  ssl: "require",
  max: 1,
  idle_timeout: 20,
  connect_timeout: 15,
  // if not exists 命中时 PG 会发 42P07 NOTICE，属预期，不打印噪音
  onnotice: () => {},
  // 建索引可能耗时，放宽单语句超时
  connection: { statement_timeout: "300000" }
});

const fmt = (n) => Number(n).toLocaleString("zh-CN");

const main = async () => {
  const host = databaseUrl.replace(/:\/\/[^@]*@/, "://***@").split("?")[0];
  console.log(`[apply-indexes] 目标库：${host}`);
  const [{ version }] = await sql`select version()`;
  console.log(`[apply-indexes] ${version.split(",")[0]}\n`);

  // ---- 1. 应用前：记录各表规模与已有索引 ----
  const tables = [...new Set(INDEXES.map((i) => i.table))];
  console.log("── 应用前表规模 ──");
  const sizes = {};
  for (const t of tables) {
    try {
      const [row] = await sql.unsafe(
        `select count(*)::bigint as rows,
                pg_size_pretty(pg_total_relation_size('public.${t}')) as size
           from public.${t}`
      );
      sizes[t] = row;
      console.log(`  ${t.padEnd(24)} ${fmt(row.rows).padStart(10)} 行   ${row.size}`);
    } catch (error) {
      console.log(`  ${t.padEnd(24)} （表不存在，跳过：${error.message.split("\n")[0]}）`);
      sizes[t] = null;
    }
  }

  const before = await sql`
    select indexname from pg_indexes
     where schemaname = 'public' and indexname = any(${INDEXES.map((i) => i.name)})
  `;
  const existed = new Set(before.map((r) => r.indexname));
  console.log(`\n── 应用前已存在 ${existed.size}/${INDEXES.length} 个目标索引 ──\n`);

  // ---- 2. 逐条创建 ----
  console.log("── 创建索引 ──");
  const results = [];
  for (const index of INDEXES) {
    if (sizes[index.table] === null) {
      console.log(`  ⏭  ${index.name} —— 基表不存在，跳过`);
      results.push({ ...index, status: "skipped" });
      continue;
    }
    const started = Date.now();
    try {
      await sql.unsafe(index.ddl);
      const ms = Date.now() - started;
      const wasNew = !existed.has(index.name);
      console.log(`  ${wasNew ? "✅ 新建" : "☑️  已存在"}  ${index.name.padEnd(44)} ${String(ms).padStart(6)} ms`);
      results.push({ ...index, status: wasNew ? "created" : "exists", ms });
    } catch (error) {
      console.log(`  ❌ 失败  ${index.name} —— ${error.message.split("\n")[0]}`);
      results.push({ ...index, status: "failed", error: error.message });
    }
  }

  // ---- 3. ANALYZE，让计划器立即采用新索引 ----
  console.log("\n── ANALYZE（刷新统计信息）──");
  for (const t of tables) {
    if (sizes[t] === null) continue;
    const started = Date.now();
    try {
      await sql.unsafe(`analyze public.${t}`);
      console.log(`  ✅ analyze ${t.padEnd(24)} ${String(Date.now() - started).padStart(6)} ms`);
    } catch (error) {
      console.log(`  ⚠️  analyze ${t} 失败：${error.message.split("\n")[0]}`);
    }
  }

  // ---- 4. 验证 ----
  console.log("\n── 验证：目标索引落库情况 ──");
  const after = await sql`
    select i.indexname,
           i.tablename,
           pg_size_pretty(pg_relation_size(('public.' || i.indexname)::regclass)) as size
      from pg_indexes i
     where i.schemaname = 'public'
       and i.indexname = any(${INDEXES.map((x) => x.name)})
     order by i.tablename, i.indexname
  `;
  for (const row of after) {
    console.log(`  ✅ ${row.indexname.padEnd(44)} ${row.tablename.padEnd(22)} ${row.size}`);
  }
  const missing = INDEXES.filter((i) => !after.some((r) => r.indexname === i.name));
  if (missing.length) {
    console.log(`\n  ⚠️  仍缺失 ${missing.length} 个：${missing.map((m) => m.name).join(", ")}`);
  }

  // ---- 5. 关键查询计划抽验（确认真的走了索引）----
  console.log("\n── 执行计划抽验 ──");
  const probes = [
    {
      label: "监控实时吞吐（imported_orders 5min 窗口）",
      table: "imported_orders",
      query: `select count(*) from public.imported_orders where created_at > now() - interval '5 minutes'`
    },
    {
      label: "任务列表（按时间倒序 limit 50）",
      table: "import_tasks",
      query: `select id, status, created_at from public.import_tasks order by created_at desc limit 50`
    },
    {
      label: "监控错误分布（24h group by error_code）",
      table: "import_task_errors",
      query: `select error_code, count(*) from public.import_task_errors where created_at > now() - interval '24 hours' group by error_code`
    }
  ];
  for (const probe of probes) {
    if (sizes[probe.table] === null) continue;
    try {
      const plan = await sql.unsafe(`explain (analyze, buffers, format text) ${probe.query}`);
      const lines = plan.map((r) => r["QUERY PLAN"]);
      const usesIndex = lines.some((l) => /Index (Only )?Scan|Bitmap Index Scan/.test(l));
      const seqScan = lines.some((l) => /Seq Scan/.test(l));
      const timing = lines.find((l) => /Execution Time/.test(l)) ?? "";
      const rows = Number(sizes[probe.table]?.rows ?? 0);
      // 小表上计划器选 Seq Scan 是正确的（顺序读整页比随机读索引更快），不代表索引无效
      const smallTable = rows < 5_000;
      const mark = usesIndex ? "✅ 走索引" : seqScan && smallTable ? "ℹ️  Seq Scan（小表，计划器正确选择）" : seqScan ? "⚠️  仍 Seq Scan" : "ℹ️ ";
      console.log(`  ${mark}  ${probe.label}`);
      console.log(`      ${lines[0]}`);
      if (timing) console.log(`      ${timing.trim()}`);
      if (!usesIndex && seqScan && smallTable) {
        console.log(`      当前仅 ${fmt(rows)} 行；数据量增长后计划器会自动切换到索引扫描。`);
      }
    } catch (error) {
      console.log(`  ⚠️  ${probe.label} 抽验失败：${error.message.split("\n")[0]}`);
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  const exists = results.filter((r) => r.status === "exists").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(
    `\n[apply-indexes] 完成：新建 ${created}，已存在 ${exists}，跳过 ${
      results.filter((r) => r.status === "skipped").length
    }，失败 ${failed}`
  );
  await sql.end({ timeout: 5 });
  process.exit(failed > 0 ? 1 : 0);
};

main().catch(async (error) => {
  console.error("[apply-indexes] 执行失败：", error.message);
  try {
    await sql.end({ timeout: 5 });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
