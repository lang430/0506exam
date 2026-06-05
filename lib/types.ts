export const orderFields = [
  "externalCode",
  "storeName",
  "receiverName",
  "receiverPhone",
  "receiverAddress",
  "skuCode",
  "skuName",
  "quantity",
  "spec",
  "remark"
] as const;

export type OrderField = (typeof orderFields)[number];

export interface OrderRow {
  id: string;
  externalCode: string;
  storeName: string;
  receiverName: string;
  receiverPhone: string;
  receiverAddress: string;
  skuCode: string;
  skuName: string;
  quantity: number | string;
  spec: string;
  remark: string;
  source: string;
  submittedAt?: string;
  errors: string[];
}

export interface SheetSnapshot {
  name: string;
  rows: string[][];
}

export type RuleMode = "table" | "matrix" | "cards" | "text";

export interface ColumnMapping {
  source: "header" | "index" | "static" | "sheet" | "regex";
  header?: string;
  index?: number;
  value?: string;
  pattern?: string;
}

export interface TailExtraction {
  field: OrderField;
  label: string;
  offset?: number;
}

export interface ParseRule {
  id: string;
  name: string;
  mode: RuleMode;
  confidence?: number;
  assumptions?: string[];
  sheetStrategy: "first" | "all";
  headerRow?: number;
  dataStartRow?: number;
  stopWhenContains?: string;
  boundaryPattern?: string;
  itemHeaderPattern?: string;
  itemPattern?: string;
  mappings: Partial<Record<OrderField, ColumnMapping>>;
  tailExtractions?: TailExtraction[];
  matrixValueStartColumn?: number;
  matrixValueEndColumn?: number;
}

export interface ValidationIssue {
  rowId: string;
  rowNumber: number;
  field: OrderField | "row";
  message: string;
}
