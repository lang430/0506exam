import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import type { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

const ensureTable = async (sql: NonNullable<ReturnType<typeof getSql>>): Promise<void> => {
  await sql`create table if not exists imported_orders (
    id text primary key,
    payload jsonb not null,
    external_code text,
    store_name text,
    receiver_name text,
    receiver_phone text,
    receiver_address text,
    sku_code text,
    sku_name text,
    quantity numeric,
    source text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists imported_orders_external_code_idx on imported_orders (external_code)`;
  await sql`create index if not exists imported_orders_receiver_name_idx on imported_orders (receiver_name)`;
  await sql`create index if not exists imported_orders_created_at_idx on imported_orders (created_at desc)`;
};

export async function GET() {
  const sql = getSql();
  if (!sql) return NextResponse.json({ rows: [], mode: "local-demo" });
  await ensureTable(sql);
  const rows = await sql`select payload, created_at from imported_orders order by created_at desc limit 500`;
  return NextResponse.json({ rows: rows.map((row) => ({ ...row.payload, submittedAt: row.created_at })), mode: "database" });
}

export async function POST(request: Request) {
  const rows = await request.json() as OrderRow[];
  const sql = getSql();
  if (!sql) return NextResponse.json({ saved: rows.length, mode: "local-demo" });
  await ensureTable(sql);
  for (const row of rows) {
    await sql`insert into imported_orders (
        id, payload, external_code, store_name, receiver_name, receiver_phone,
        receiver_address, sku_code, sku_name, quantity, source, updated_at
      )
      values (
        ${row.id}, ${sql.json(JSON.parse(JSON.stringify(row)))}, ${row.externalCode}, ${row.storeName},
        ${row.receiverName}, ${row.receiverPhone}, ${row.receiverAddress}, ${row.skuCode},
        ${row.skuName}, ${Number(row.quantity) || null}, ${row.source}, now()
      )
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
        source = excluded.source,
        updated_at = now()`;
  }
  return NextResponse.json({ saved: rows.length, mode: "database" });
}
