import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import type { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

const ensureTable = async (sql: NonNullable<ReturnType<typeof getSql>>): Promise<void> => {
  await sql`create extension if not exists pgcrypto`;
  await sql`create table if not exists import_batches (
    id uuid primary key default gen_random_uuid(),
    file_name text,
    rule_id text,
    total_rows bigint not null default 0 check (total_rows >= 0),
    success_rows bigint not null default 0 check (success_rows >= 0),
    failed_rows bigint not null default 0 check (failed_rows >= 0),
    status text not null default 'submitted' check (status in ('draft', 'submitted', 'failed')),
    created_at timestamptz not null default now()
  )`;
  await sql`create table if not exists imported_orders (
    id text primary key,
    batch_id uuid references import_batches(id) on delete set null,
    payload jsonb not null,
    external_code text,
    store_name text,
    receiver_name text,
    receiver_phone text,
    receiver_address text,
    sku_code text,
    sku_name text,
    quantity numeric,
    spec text,
    remark text,
    source text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`alter table imported_orders add column if not exists batch_id uuid references import_batches(id) on delete set null`;
  await sql`alter table imported_orders add column if not exists spec text`;
  await sql`alter table imported_orders add column if not exists remark text`;
  await sql`create index if not exists imported_orders_external_code_idx on imported_orders (external_code)`;
  await sql`create index if not exists imported_orders_receiver_name_idx on imported_orders (receiver_name)`;
  await sql`create index if not exists imported_orders_created_at_idx on imported_orders (created_at desc)`;
  await sql`create index if not exists import_batches_created_at_idx on import_batches (created_at desc)`;
};

export async function GET() {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法读取已导入运单" }, { status: 503 });
  await ensureTable(sql);
  const rows = await sql`select payload, created_at from imported_orders order by created_at desc limit 500`;
  return NextResponse.json({ rows: rows.map((row) => ({ ...row.payload, submittedAt: row.created_at })), mode: "database" });
}

export async function DELETE() {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法清空已导入运单" }, { status: 503 });
  await ensureTable(sql);
  const result = await sql.begin(async (transaction) => {
    const orders = await transaction`delete from imported_orders returning id`;
    const batches = await transaction`delete from import_batches returning id`;
    return { orders: orders.length, batches: batches.length };
  });
  return NextResponse.json({ cleared: true, deletedOrders: result.orders, deletedBatches: result.batches, mode: "database" });
}

export async function POST(request: Request) {
  const payload = await request.json() as OrderRow[] | { fileName?: string; ruleId?: string; rows?: OrderRow[] };
  const rows = Array.isArray(payload) ? payload : payload.rows ?? [];
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，运单数据未写入" }, { status: 503 });
  await ensureTable(sql);
  const result = await sql.begin(async (transaction) => {
    const [batch] = await transaction<{ id: string; created_at: Date }[]>`
      insert into import_batches (file_name, rule_id, total_rows, success_rows, failed_rows, status)
      values (${Array.isArray(payload) ? null : payload.fileName ?? null}, ${Array.isArray(payload) ? null : payload.ruleId ?? null}, ${rows.length}, ${rows.length}, 0, 'submitted')
      returning id, created_at
    `;
    for (const row of rows) {
      const storedRow = { ...row, submittedAt: batch.created_at };
      await transaction`insert into imported_orders (
          id, batch_id, payload, external_code, store_name, receiver_name, receiver_phone,
          receiver_address, sku_code, sku_name, quantity, spec, remark, source, updated_at
        )
        values (
          ${row.id}, ${batch.id}, ${transaction.json(JSON.parse(JSON.stringify(storedRow)))}, ${row.externalCode}, ${row.storeName},
          ${row.receiverName}, ${row.receiverPhone}, ${row.receiverAddress}, ${row.skuCode},
          ${row.skuName}, ${Number(row.quantity) || null}, ${row.spec}, ${row.remark}, ${row.source}, now()
        )
        on conflict (id) do update set
          batch_id = excluded.batch_id,
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
          updated_at = now()`;
    }
    return { batchId: batch.id, submittedAt: batch.created_at, rows: rows.map((row) => ({ ...row, submittedAt: batch.created_at })) };
  });
  return NextResponse.json({ saved: rows.length, failed: 0, mode: "database", ...result });
}
