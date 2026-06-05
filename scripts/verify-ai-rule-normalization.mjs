import ExcelJS from "exceljs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseByRule, validateRows } from "../lib/rule-engine.ts";

const cellText = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "object" && "text" in cell) return String(cell.text ?? "");
  if (typeof cell === "object" && "result" in cell) return String(cell.result ?? "");
  if (typeof cell === "object" && Array.isArray(cell.richText)) return cell.richText.map((item) => item.text).join("");
  return String(cell);
};

const demoDir = join(process.cwd(), "demos");
const targetFile = "12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx";
const fileName = existsSync(join(demoDir, targetFile))
  ? targetFile
  : readdirSync(demoDir, { encoding: "utf8" }).find((name) => name.includes("PS2512220005001"));
if (!fileName) throw new Error("未找到目标 Excel 文件");

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(join(demoDir, fileName));
const sheets = workbook.worksheets.slice(0, 1).map((sheet) => ({
  name: sheet.name,
  rows: sheet.getSheetValues().slice(1).map((row) =>
    Array.isArray(row) ? row.slice(1).map(cellText) : []
  )
}));

const modelLikeRule = {
  id: "verify-normalized-ai-rule",
  name: "黎明屯铁锅炖配送发货单导入规则",
  mode: "table",
  sheetStrategy: "first",
  headerRow: 4,
  dataStartRow: 5,
  stopWhenContains: "合计",
  mappings: {
    skuCode: { source: "header", header: "物品编码" },
    skuName: { source: "header", header: "物品名称" },
    quantity: { source: "header", header: "原订货数量" },
    spec: { source: "header", header: "规格型号" },
    remark: { source: "header", header: "备注" }
  },
  tailExtractions: [
    { field: "receiverName", label: "收货人" },
    { field: "receiverPhone", label: "收货电话" },
    { field: "receiverAddress", label: "收货地址" },
    { field: "storeName", label: "收货机构" }
  ]
};

const rows = parseByRule(sheets, modelLikeRule);
const issues = validateRows(rows, new Set());
const first = rows[0] ?? {};

console.log(JSON.stringify({
  fileName,
  rows: rows.length,
  issues: issues.length,
  first: {
    storeName: first.storeName,
    receiverName: first.receiverName,
    receiverPhone: first.receiverPhone,
    receiverAddress: first.receiverAddress,
    skuCode: first.skuCode,
    skuName: first.skuName,
    quantity: first.quantity
  }
}, null, 2));

if (
  rows.length !== 2 ||
  issues.length ||
  !first.storeName ||
  !first.receiverName ||
  !first.receiverPhone ||
  !first.receiverAddress ||
  !first.skuCode ||
  !first.skuName ||
  !(Number(first.quantity) > 0)
) {
  process.exit(1);
}
