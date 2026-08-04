/**
 * 单表索引明细诊断工具。
 *
 * 用途：打印指定表的全部索引 DDL、体积与实际扫描次数，用于识别
 *      「体积大但从未被使用」的僵尸索引（本项目据此发现并移除了
 *      imported_orders_payload_gin_idx —— 8.6MB 且 idx_scan=0）。
 *
 * 与 scripts/db-health.mjs 的区别：db-health 做全库概览巡检，
 * 本脚本聚焦单表并额外输出 indexdef（建索引语句原文）。
 *
 * 用法：node scripts/db-inspect-idx.mjs [表名]   默认 imported_orders
 * 连接：自动读取 .env.local 的 POSTGRES_URL_NON_POOLING / POSTGRES_URL
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const raw of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
}

const tableName = (process.argv[2] ?? "imported_orders").trim();

const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  ssl: "require", max: 1, connect_timeout: 15
});

const exists = await sql`
  select 1 from information_schema.tables
   where table_schema = 'public' and table_name = ${tableName} limit 1
`;
if (!exists.length) {
  console.error(`表 public.${tableName} 不存在。用法：node scripts/db-inspect-idx.mjs [表名]`);
  await sql.end();
  process.exit(1);
}

// 索引 DDL + 体积 + 实际扫描次数（idx_scan=0 即上线至今从未被查询命中）
const rows = await sql`
  select i.indexname,
         i.indexdef,
         pg_size_pretty(pg_relation_size(('public.' || i.indexname)::regclass)) as size,
         coalesce(s.idx_scan, 0) as idx_scan
    from pg_indexes i
    left join pg_stat_user_indexes s
      on s.schemaname = i.schemaname and s.indexrelname = i.indexname
   where i.schemaname = 'public' and i.tablename = ${tableName}
   order by pg_relation_size(('public.' || i.indexname)::regclass) desc
`;

console.log(`── public.${tableName} 索引（按体积倒序）──`);
if (!rows.length) console.log("（无索引）");
for (const r of rows) {
  const scans = Number(r.idx_scan);
  const flag = scans === 0 ? "  ⚠️ 从未使用" : "";
  console.log(`${r.size.padStart(9)}  scans=${String(scans).padStart(6)}${flag}`);
  console.log(`           ${r.indexdef}`);
}

console.log(`\n── public.${tableName} 列 ──`);
const cols = await sql`
  select column_name, data_type from information_schema.columns
   where table_schema = 'public' and table_name = ${tableName} order by ordinal_position`;
console.log(cols.map((c) => `${c.column_name}:${c.data_type}`).join(", "));

await sql.end();
