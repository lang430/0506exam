import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";
import { loadV3ContractWaybill, verifyV3ContractSku } from "@/lib/v3-contract";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ externalCode: string; skuCode: string }> }
) {
  const sql = getSql();
  if (!sql) return NextResponse.json({ error: "数据库未配置，无法校验 SKU" }, { status: 503 });
  const { externalCode, skuCode } = await params;
  const waybill = await loadV3ContractWaybill(sql, decodeURIComponent(externalCode));
  return NextResponse.json(verifyV3ContractSku(waybill, decodeURIComponent(skuCode)));
}
