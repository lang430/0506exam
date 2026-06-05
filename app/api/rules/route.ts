import { NextResponse } from "next/server";
import postgres from "postgres";
import { defaultRules } from "@/lib/default-rules";
import { getSql } from "@/lib/db";
import type { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

const ensureTable = async (sql: postgres.Sql): Promise<void> => {
  await sql`create table if not exists parse_rules (
    id text primary key,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`;
  await sql`create index if not exists parse_rules_updated_at_idx on parse_rules (updated_at desc)`;
};

export async function GET() {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法读取解析规则" }, { status: 503 });
  await ensureTable(sql);
  const rows = await sql`select payload from parse_rules order by updated_at desc`;
  if (!rows.length) {
    for (const rule of defaultRules) {
      await sql`insert into parse_rules (id, payload) values (${rule.id}, ${sql.json(JSON.parse(JSON.stringify(rule)))}) on conflict do nothing`;
    }
    return NextResponse.json({ rules: defaultRules, mode: "database" });
  }
  return NextResponse.json({ rules: rows.map((row) => row.payload), mode: "database" });
}

export async function POST(request: Request) {
  const rule = await request.json() as ParseRule;
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，解析规则未保存" }, { status: 503 });
  await ensureTable(sql);
  await sql`insert into parse_rules (id, payload, updated_at)
    values (${rule.id}, ${sql.json(JSON.parse(JSON.stringify(rule)))}, now())
    on conflict (id) do update set payload = excluded.payload, updated_at = now()`;
  const rows = await sql`select payload from parse_rules order by updated_at desc`;
  return NextResponse.json({ rules: rows.map((row) => row.payload), mode: "database" });
}

export async function DELETE(request: Request) {
  const { id } = await request.json() as { id: string };
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，解析规则未删除" }, { status: 503 });
  await ensureTable(sql);
  await sql`delete from parse_rules where id = ${id}`;
  const rows = await sql`select payload from parse_rules order by updated_at desc`;
  return NextResponse.json({ rules: rows.map((row) => row.payload), mode: "database" });
}
