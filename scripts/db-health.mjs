#!/usr/bin/env node
/**
 * 数据库健康巡检：表膨胀（死元组）、索引体积、autovacuum 状态、未使用索引。
 * 用法：node scripts/db-health.mjs [--vacuum]
 *   --vacuum  对膨胀严重的表执行 vacuum analyze
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  const full = path.join(projectRoot, file);
  if (!fs.existsSync(full)) continue;
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

const url = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("[db-health] 缺少数据库连接串");
  process.exit(1);
}

const doVacuum = process.argv.includes("--vacuum");
const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 15, connection: { statement_timeout: "300000" } });

const main = async () => {
  console.log("── 表规模与膨胀情况 ──");
  const stats = await sql`
    select relname as table_name,
           n_live_tup as live_rows,
           n_dead_tup as dead_rows,
           pg_table_size(relid) as heap_bytes,
           pg_size_pretty(pg_table_size(relid)) as heap_size,
           pg_size_pretty(pg_indexes_size(relid)) as index_size,
           last_vacuum, last_autovacuum
      from pg_stat_user_tables
     where schemaname = 'public'
     order by pg_table_size(relid) desc
     limit 12
  `;
  console.table(
    stats.map((r) => ({
      表: r.table_name,
      活行: Number(r.live_rows),
      死行: Number(r.dead_rows),
      堆大小: r.heap_size,
      索引: r.index_size,
      死行占比: Number(r.live_rows) + Number(r.dead_rows) > 0
        ? `${((Number(r.dead_rows) / (Number(r.live_rows) + Number(r.dead_rows))) * 100).toFixed(1)}%`
        : "-",
      上次autovacuum: r.last_autovacuum ? new Date(r.last_autovacuum).toISOString().slice(0, 19) : "从未"
    }))
  );

  // 膨胀判定：死行占比 > 20%。
  // 注意：不能只看「行少堆大」——import_task_files 存的是原始文件字节、
  // imported_orders 有 jsonb payload，堆大属正常，误判会导致对大表做阻塞式 VACUUM FULL。
  const deadRatio = (r) => {
    const live = Number(r.live_rows);
    const dead = Number(r.dead_rows);
    return live + dead > 0 ? dead / (live + dead) : 0;
  };
  const bloated = stats.filter((r) => deadRatio(r) > 0.2);
  if (bloated.length) {
    console.log(`\n⚠️  死元组占比偏高 ${bloated.length} 个表：`);
    for (const b of bloated) {
      console.log(`   ${b.table_name.padEnd(24)} ${(deadRatio(b) * 100).toFixed(1)}%  ${b.heap_size}`);
    }
    console.log("   （热路径高频 UPDATE 表；死元组会让顺序扫描多读空页）");
  } else {
    console.log("\n✅ 无明显死元组堆积");
  }

  if (doVacuum) {
    // 全部表做非阻塞 VACUUM ANALYZE；仅对「膨胀且小于 1MB」的表做 VACUUM FULL（瞬时完成，锁影响可忽略）
    console.log("\n── VACUUM ANALYZE（非阻塞，全表）──");
    for (const t of stats) {
      const started = Date.now();
      try {
        await sql.unsafe(`vacuum analyze public.${t.table_name}`);
        console.log(`  ✅ ${t.table_name.padEnd(24)} ${String(Date.now() - started).padStart(6)} ms`);
      } catch (error) {
        console.log(`  ⚠️  ${t.table_name} 失败：${error.message.split("\n")[0]}`);
      }
    }

    const compactable = bloated.filter((t) => Number(t.heap_bytes) < 1024 * 1024);
    if (compactable.length) {
      console.log("\n── VACUUM FULL（仅 <1MB 的膨胀小表，瞬时完成）──");
      for (const t of compactable) {
        const started = Date.now();
        try {
          await sql.unsafe(`vacuum full analyze public.${t.table_name}`);
          console.log(`  ✅ ${t.table_name.padEnd(24)} ${String(Date.now() - started).padStart(6)} ms`);
        } catch (error) {
          console.log(`  ⚠️  ${t.table_name} 失败：${error.message.split("\n")[0]}`);
        }
      }
    }

    const after = await sql`
      select relname as table_name, pg_size_pretty(pg_table_size(relid)) as heap_size, n_dead_tup as dead_rows
        from pg_stat_user_tables
       where schemaname='public'
       order by pg_table_size(relid) desc limit 12
    `;
    console.log("\n── 回收后 ──");
    console.table(after.map((r) => ({ 表: r.table_name, 堆大小: r.heap_size, 死行: Number(r.dead_rows) })));
  } else if (bloated.length) {
    console.log("   → 执行 `node scripts/db-health.mjs --vacuum` 回收空间");
  }

  console.log("\n── 索引使用情况（scan=0 为从未被使用）──");
  const idx = await sql`
    select relname as table_name, indexrelname as index_name,
           idx_scan as scans, pg_size_pretty(pg_relation_size(indexrelid)) as size
      from pg_stat_user_indexes
     where schemaname = 'public'
     order by idx_scan asc, pg_relation_size(indexrelid) desc
     limit 30
  `;
  console.table(idx.map((r) => ({ 表: r.table_name, 索引: r.index_name, 扫描次数: Number(r.scans), 大小: r.size })));

  await sql.end({ timeout: 5 });
};

main().catch(async (error) => {
  console.error("[db-health] 失败：", error.message);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
