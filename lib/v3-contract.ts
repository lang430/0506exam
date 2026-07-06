import type postgres from "postgres";
import type { OrderRow } from "@/lib/types";

export const V3_CONTRACT_SCHEMA_VERSION = "1.0";

export interface V3ContractSkuItem {
  skuCode: string;
  skuName: string;
  quantity: string;
  spec: string;
}

export interface V3ContractWaybill {
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  amount: string;
  updatedAt: string;
  schemaVersion: string;
  skuItems: V3ContractSkuItem[];
}

interface ImportedOrderRow {
  payload: unknown;
  external_code: string | null;
  store_name: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  receiver_address: string | null;
  sku_code: string | null;
  sku_name: string | null;
  quantity: string | null;
  spec: string | null;
  updated_at: Date;
}

const text = (value: unknown): string => String(value ?? "").trim();

const payloadValue = (payload: unknown, key: keyof OrderRow): string => {
  if (!payload || typeof payload !== "object") return "";
  return text((payload as Partial<OrderRow>)[key]);
};

export const normalizeImportedRowsToWaybill = (
  rows: ImportedOrderRow[],
  externalCode: string
): V3ContractWaybill | null => {
  if (!rows.length) return null;
  const [head] = rows;
  const updatedAt = rows
    .map((row) => row.updated_at)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    externalCode,
    storeName: text(head.store_name) || payloadValue(head.payload, "storeName"),
    receiverName: text(head.receiver_name) || payloadValue(head.payload, "receiverName"),
    receiverPhone: text(head.receiver_phone) || payloadValue(head.payload, "receiverPhone"),
    receiverAddress: text(head.receiver_address) || payloadValue(head.payload, "receiverAddress"),
    amount: "0.00",
    updatedAt: updatedAt.toISOString(),
    schemaVersion: V3_CONTRACT_SCHEMA_VERSION,
    skuItems: rows
      .map((row) => ({
        skuCode: text(row.sku_code) || payloadValue(row.payload, "skuCode"),
        skuName: text(row.sku_name) || payloadValue(row.payload, "skuName"),
        quantity: text(row.quantity) || payloadValue(row.payload, "quantity"),
        spec: text(row.spec) || payloadValue(row.payload, "spec")
      }))
      .filter((item) => item.skuCode || item.skuName)
  };
};

export const loadV3ContractWaybill = async (
  sql: postgres.Sql,
  externalCode: string
): Promise<V3ContractWaybill | null> => {
  const rows = await sql<ImportedOrderRow[]>`
    select
      payload,
      external_code,
      store_name,
      receiver_name,
      receiver_phone,
      receiver_address,
      sku_code,
      sku_name,
      quantity::text,
      spec,
      updated_at
    from imported_orders
    where external_code = ${externalCode}
    order by created_at asc
    limit 500
  `;
  return normalizeImportedRowsToWaybill(rows, externalCode);
};

export const listV3ContractWaybills = async (
  sql: postgres.Sql,
  options: { updatedAfter?: string | null; limit?: number }
): Promise<V3ContractWaybill[]> => {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = await sql<{ external_code: string }[]>`
    select external_code
    from imported_orders
    where external_code is not null
      and external_code <> ''
      and (${options.updatedAfter ?? null}::timestamptz is null or updated_at > ${options.updatedAfter ?? null}::timestamptz)
    group by external_code
    order by max(updated_at) desc
    limit ${limit}
  `;
  const waybills: V3ContractWaybill[] = [];
  for (const row of rows) {
    const waybill = await loadV3ContractWaybill(sql, row.external_code);
    if (waybill) waybills.push(waybill);
  }
  return waybills;
};

export const verifyV3ContractSku = (
  waybill: V3ContractWaybill | null,
  skuCode: string
) => ({
  exists: Boolean(waybill),
  belongsToOrder: Boolean(waybill?.skuItems.some((item) => item.skuCode === skuCode)),
  externalCode: waybill?.externalCode ?? "",
  skuItem: waybill?.skuItems.find((item) => item.skuCode === skuCode) ?? null,
  schemaVersion: V3_CONTRACT_SCHEMA_VERSION
});
