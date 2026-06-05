import { NextResponse } from "next/server";
import postgres from "postgres";
import type { OrderRow } from "@/lib/types";

export const runtime = "nodejs";

const getSql = () => {
  const url = process.env.DATABASE_URL;
  return url ? postgres(url, { ssl: "require", max: 1 }) : null;
};

export async function GET() {
  const sql = getSql();
  if (!sql) return NextResponse.json({ rows: [], mode: "local-demo" });
  await sql`create table if not exists imported_orders (
    id text primary key,
    payload jsonb not null,
    external_code text,
    receiver_name text,
    created_at timestamptz default now()
  )`;
  const rows = await sql`select payload from imported_orders order by created_at desc limit 500`;
  return NextResponse.json({ rows: rows.map((row) => row.payload), mode: "database" });
}

export async function POST(request: Request) {
  const rows = await request.json() as OrderRow[];
  const sql = getSql();
  if (!sql) return NextResponse.json({ saved: rows.length, mode: "local-demo" });
  await sql`create table if not exists imported_orders (
    id text primary key,
    payload jsonb not null,
    external_code text,
    receiver_name text,
    created_at timestamptz default now()
  )`;
  for (const row of rows) {
    await sql`insert into imported_orders (id, payload, external_code, receiver_name)
      values (${row.id}, ${sql.json(JSON.parse(JSON.stringify(row)))}, ${row.externalCode}, ${row.receiverName})
      on conflict (id) do update set payload = excluded.payload`;
  }
  return NextResponse.json({ saved: rows.length, mode: "database" });
}
