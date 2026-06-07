import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import type { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

const ensureTable = async (sql: NonNullable<ReturnType<typeof getSql>>): Promise<void> => {
  await sql`create extension if not exists pgcrypto`;
  await sql`create table if not exists parse_rules (
    id text primary key,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
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

const escapeLike = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

export async function GET(request: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法读取已导入运单" }, { status: 503 });
  await ensureTable(sql);
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get("q")?.trim();
  const externalCode = searchParams.get("externalCode")?.trim();
  const receiverName = searchParams.get("receiverName")?.trim();
  const dateFrom = searchParams.get("dateFrom")?.trim();
  const dateTo = searchParams.get("dateTo")?.trim();
  const keywordLike = keyword ? `%${escapeLike(keyword)}%` : "";
  const externalLike = externalCode ? `%${escapeLike(externalCode)}%` : "";
  const receiverLike = receiverName ? `%${escapeLike(receiverName)}%` : "";
  const rows = await sql`
    select payload, created_at
    from imported_orders
    where (${keyword ?? null}::text is null or (
      external_code ilike ${keywordLike} escape '\' or
      store_name ilike ${keywordLike} escape '\' or
      receiver_name ilike ${keywordLike} escape '\' or
      receiver_phone ilike ${keywordLike} escape '\' or
      receiver_address ilike ${keywordLike} escape '\' or
      sku_code ilike ${keywordLike} escape '\' or
      sku_name ilike ${keywordLike} escape '\' or
      spec ilike ${keywordLike} escape '\' or
      remark ilike ${keywordLike} escape '\'
    ))
      and (${externalCode ?? null}::text is null or external_code ilike ${externalLike} escape '\')
      and (${receiverName ?? null}::text is null or receiver_name ilike ${receiverLike} escape '\')
      and (${dateFrom ?? null}::date is null or created_at >= ${dateFrom ?? null}::date)
      and (${dateTo ?? null}::date is null or created_at < (${dateTo ?? null}::date + interval '1 day'))
    order by created_at desc
    limit 500
  `;
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
  try {
    const payload = await request.json() as OrderRow[] | { fileName?: string; ruleId?: string; rows?: OrderRow[] };
    const rows = Array.isArray(payload) ? payload : payload.rows ?? [];
    const sql = getSql();
    if (!sql) return NextResponse.json({ error: "数据库未配置，运单数据未写入" }, { status: 503 });
    await ensureTable(sql);
    const result = await sql.begin(async (transaction) => {
      const requestedRuleId = Array.isArray(payload) ? null : payload.ruleId?.trim() || null;
      const validRuleId = requestedRuleId
        ? (await transaction<{ id: string }[]>`select id from parse_rules where id = ${requestedRuleId} limit 1`)[0]?.id ?? null
        : null;
      const [batch] = await transaction<{ id: string; created_at: Date }[]>`
        insert into import_batches (file_name, rule_id, total_rows, success_rows, failed_rows, status)
        values (${Array.isArray(payload) ? null : payload.fileName ?? null}, ${validRuleId}, ${rows.length}, ${rows.length}, 0, 'submitted')
        returning id, created_at
      `;
      if (rows.length) {
        const orderValues = rows.map((row) => {
          const storedRow = { ...row, submittedAt: batch.created_at };
          return {
            id: row.id,
            batch_id: batch.id,
            payload: transaction.json(JSON.parse(JSON.stringify(storedRow))),
            external_code: row.externalCode,
            store_name: row.storeName,
            receiver_name: row.receiverName,
            receiver_phone: row.receiverPhone,
            receiver_address: row.receiverAddress,
            sku_code: row.skuCode,
            sku_name: row.skuName,
            quantity: Number(row.quantity) || null,
            spec: row.spec,
            remark: row.remark,
            source: row.source
          };
        });
        await transaction`insert into imported_orders (
          id, batch_id, payload, external_code, store_name, receiver_name, receiver_phone,
          receiver_address, sku_code, sku_name, quantity, spec, remark, source
        )
        values ${transaction(orderValues,
          "id",
          "batch_id",
          "payload",
          "external_code",
          "store_name",
          "receiver_name",
          "receiver_phone",
          "receiver_address",
          "sku_code",
          "sku_name",
          "quantity",
          "spec",
          "remark",
          "source"
        )}
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
      return { batchId: batch.id, ruleId: validRuleId, submittedAt: batch.created_at, rows: rows.map((row) => ({ ...row, submittedAt: batch.created_at })) };
    });
    return NextResponse.json({ saved: rows.length, failed: 0, mode: "database", ...result });
  } catch (error) {
    console.error("[orders] write-failed", error);
    return NextResponse.json({ error: "运单数据写入失败，请稍后重试或检查数据库连接" }, { status: 500 });
  }
}
