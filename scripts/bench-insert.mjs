#!/usr/bin/env node
/**
 * 量化 imported_orders 写入路径的索引维护成本。
 *
 * 方法：在事务内批量插入 N 行后 ROLLBACK —— 索引维护开销真实发生，
 * 但不污染生产数据。分别在「有 GIN 索引」与「无 GIN 索引」下测量。
 *
 * 用法：node scripts/bench-insert.mjs [rows]        # 默认保持 GIN 移除
 *   node scripts/bench-insert.mjs 2000 --restore-gin  # 测完重建 GIN
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const raw of fs.readFileSync(path.join(root, ".env.local"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
}

const ROWS = Number(process.argv[2] ?? 2000);
const sql = postgres(process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL, {
  ssl: "require", max: 1, connect_timeout: 15, connection: { statement_timeout: "300000" }
});

/** 构造与真实导入同构的行（payload 为完整原始行 jsonb，GIN 索引正是建在它上面） */
const buildRows = (n, tag) =>
  Array.from({ length: n }, (_, i) => {
    const code = `BENCH-${tag}-${String(i).padStart(6, "0")}`;
    return {
      id: `bench_${tag}_${i}`,
      batch_id: null,
      payload: {
        订单编号: code, 店铺名称: "压测店铺", 收件人: `测试用户${i}`,
        收件人电话: "13800000000", 收件人地址: "广东省深圳市南山区科技园某某路 100 号",
        商品编码: `SKU${String(i % 20000).padStart(6, "0")}`, 商品名称: `压测商品${i % 500}`,
        数量: (i % 9) + 1, 规格: "标准装", 备注: "索引成本压测行，事务内回滚不落库"
      },
      external_code: code,
      store_name: "压测店铺",
      receiver_name: `测试用户${i}`,
      receiver_phone: "13800000000",
      receiver_address: "广东省深圳市南山区科技园某某路 100 号",
      sku_code: `SKU${String(i % 20000).padStart(6, "0")}`,
      sku_name: `压测商品${i % 500}`,
      quantity: (i % 9) + 1,
      spec: "标准装",
      remark: "索引成本压测行",
      source: "bench",
      line_no: i + 1
    };
  });

/** 事务内插入后回滚，返回纯插入耗时（ms） */
const measure = async (label) => {
  const tag = crypto.randomBytes(4).toString("hex");
  const rows = buildRows(ROWS, tag);
  let elapsed = 0;
  try {
    await sql.begin(async (tx) => {
      const started = Date.now();
      const chunk = 500;
      for (let i = 0; i < rows.length; i += chunk) {
        const slice = rows.slice(i, i + chunk).map((r) => ({ ...r, payload: JSON.stringify(r.payload) }));
        await tx`insert into imported_orders ${tx(slice)}`;
      }
      elapsed = Date.now() - started;
      throw new Error("__ROLLBACK__");
    });
  } catch (error) {
    if (!String(error.message).includes("__ROLLBACK__")) throw error;
  }
  const perRow = (elapsed / ROWS).toFixed(3);
  const perMin = Math.round((ROWS / elapsed) * 60_000);
  console.log(`  ${label.padEnd(22)} ${String(elapsed).padStart(6)} ms   ${perRow} ms/行   ≈${perMin.toLocaleString("zh-CN")} 行/分钟`);
  return elapsed;
};

const main = async () => {
  console.log(`\n[bench-insert] 每轮插入 ${ROWS.toLocaleString("zh-CN")} 行（事务内回滚，不落库）\n`);

  const idx = await sql`
    select indexname from pg_indexes
     where schemaname='public' and indexname='imported_orders_payload_gin_idx'`;
  const hasGin = idx.length > 0;
  console.log(`当前 payload GIN 索引：${hasGin ? "存在" : "不存在"}\n`);

  console.log("── 预热（排除连接/计划缓存干扰）──");
  await measure("warmup");

  console.log(`\n── A. ${hasGin ? "含" : "不含"} GIN 索引 ──`);
  const a1 = await measure("run 1");
  const a2 = await measure("run 2");
  const withGin = Math.min(a1, a2);

  if (!hasGin) {
    console.log("\n[bench-insert] GIN 索引已不存在，无法做对比。");
    await sql.end({ timeout: 5 });
    return;
  }

  console.log("\n── B. 临时移除 GIN 索引后重测 ──");
  await sql.unsafe(`drop index if exists public.imported_orders_payload_gin_idx`);
  const b1 = await measure("run 1");
  const b2 = await measure("run 2");
  const withoutGin = Math.min(b1, b2);

  const saved = withGin - withoutGin;
  const pct = ((saved / withGin) * 100).toFixed(1);
  console.log("\n── 结论 ──");
  console.log(`  含 GIN：  ${withGin} ms / ${ROWS} 行`);
  console.log(`  无 GIN：  ${withoutGin} ms / ${ROWS} 行`);
  console.log(`  提升：    ${saved} ms（${pct}%）`);
  const per10k = (saved / ROWS) * 10_000;
  console.log(`  折算 1 万行导入可节省约 ${(per10k / 1000).toFixed(2)} 秒\n`);

  // 默认保持删除状态：该索引 idx_scan=0、无代码使用，已在 database-v4.sql 中显式 drop。
  if (process.argv.includes("--restore-gin")) {
    console.log("[bench-insert] --restore-gin：重建 GIN 索引...");
    const started = Date.now();
    await sql.unsafe(`create index if not exists imported_orders_payload_gin_idx on public.imported_orders using gin (payload)`);
    console.log(`[bench-insert] 已重建（${Date.now() - started} ms）`);
  } else {
    console.log("[bench-insert] 保持 GIN 索引移除状态（如需重建请加 --restore-gin）。");
  }

  await sql.end({ timeout: 5 });
};

main().catch(async (error) => {
  console.error("[bench-insert] 失败：", error.message);
  try { await sql.end({ timeout: 5 }); } catch { /* ignore */ }
  process.exit(1);
});
