import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NextResponse } from "next/server";
import postgres from "postgres";
import { defaultRules } from "@/lib/default-rules";
import { getSql } from "@/lib/db";
import type { ParseRule } from "@/lib/types";

export const runtime = "nodejs";

const filePath = join(process.cwd(), ".data", "rules.json");

const readFileRules = async (): Promise<ParseRule[]> => {
  try {
    const rules = JSON.parse(await readFile(filePath, "utf-8")) as ParseRule[];
    const mergedRules = [
      ...rules,
      ...defaultRules.filter((defaultRule) => !rules.some((rule) => rule.id === defaultRule.id))
    ];
    if (mergedRules.length !== rules.length) await writeFileRules(mergedRules);
    return mergedRules;
  } catch {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(defaultRules, null, 2), "utf-8");
    return defaultRules;
  }
};

const writeFileRules = async (rules: ParseRule[]): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(rules, null, 2), "utf-8");
};

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
  if (!sql) return NextResponse.json({ rules: await readFileRules(), mode: "file" });
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
  if (!sql) {
    const rules = await readFileRules();
    const nextRules = [rule, ...rules.filter((item) => item.id !== rule.id)];
    await writeFileRules(nextRules);
    return NextResponse.json({ rules: nextRules, mode: "file" });
  }
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
  if (!sql) {
    const nextRules = (await readFileRules()).filter((rule) => rule.id !== id);
    await writeFileRules(nextRules);
    return NextResponse.json({ rules: nextRules, mode: "file" });
  }
  await ensureTable(sql);
  await sql`delete from parse_rules where id = ${id}`;
  const rows = await sql`select payload from parse_rules order by updated_at desc`;
  return NextResponse.json({ rules: rows.map((row) => row.payload), mode: "database" });
}
