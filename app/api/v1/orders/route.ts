import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { listV3ContractWaybills, V3_CONTRACT_SCHEMA_VERSION } from "@/lib/v3-contract";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法同步运单" }, { status: 503 });
  const { searchParams } = new URL(request.url);
  const updatedAfter = searchParams.get("updatedAfter");
  const limit = Number(searchParams.get("limit") ?? 100);
  const items = await listV3ContractWaybills(sql, { updatedAfter, limit });
  return NextResponse.json({
    items,
    nextCursor: null,
    serverTime: new Date().toISOString(),
    schemaVersion: V3_CONTRACT_SCHEMA_VERSION
  });
}
