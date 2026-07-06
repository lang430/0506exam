import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { loadV3ContractWaybill } from "@/lib/v3-contract";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ externalCode: string }> }
) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法查询运单" }, { status: 503 });
  const { externalCode } = await params;
  const waybill = await loadV3ContractWaybill(sql, decodeURIComponent(externalCode));
  if (!waybill) return NextResponse.json({ error: "运单不存在" }, { status: 404 });
  return NextResponse.json(waybill);
}
