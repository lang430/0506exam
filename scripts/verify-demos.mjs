import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { parseByRule, validateRows } from "../lib/rule-engine.ts";

const root = new URL("../demos/", import.meta.url);

const rules = [
  {
    id: "tail-info",
    name: "尾部收货信息",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 4,
    dataStartRow: 5,
    stopWhenContains: "合计",
    mappings: {
      skuCode: { source: "index", index: 3 },
      skuName: { source: "index", index: 4 },
      quantity: { source: "index", index: 12 },
      spec: { source: "index", index: 6 }
    },
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" },
      { field: "storeName", label: "收货机构" }
    ]
  },
  {
    id: "multi-sheet",
    name: "多 Sheet 同构出库单",
    mode: "table",
    sheetStrategy: "all",
    headerRow: 4,
    dataStartRow: 5,
    stopWhenContains: "合计",
    mappings: {
      storeName: { source: "sheet" },
      skuCode: { source: "header", header: "物品编码" },
      skuName: { source: "header", header: "物品名称" },
      spec: { source: "header", header: "规格型号" },
      quantity: { source: "header", header: "出库数量" },
      remark: { source: "header", header: "备注" }
    },
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" }
    ]
  },
  {
    id: "table-hunan",
    name: "标准明细表",
    mode: "table",
    sheetStrategy: "first",
    headerRow: 2,
    dataStartRow: 3,
    mappings: {
      externalCode: { source: "header", header: "配送单号" },
      storeName: { source: "header", header: "收货机构" },
      skuCode: { source: "header", header: "物品编码*" },
      skuName: { source: "header", header: "物品名称" },
      quantity: { source: "header", header: "应发数量" },
      spec: { source: "header", header: "规格型号" },
      remark: { source: "header", header: "备注" }
    }
  },
  {
    id: "cards",
    name: "卡片式调拨单",
    mode: "cards",
    sheetStrategy: "first",
    boundaryPattern: "调拨记录",
    itemHeaderPattern: "物品编码",
    mappings: {
      skuCode: { source: "header", header: "物品编码" },
      skuName: { source: "header", header: "物品名称" },
      spec: { source: "header", header: "规格型号" },
      quantity: { source: "header", header: "数量" },
      remark: { source: "header", header: "备注" }
    },
    tailExtractions: [
      { field: "storeName", label: "调入门店" },
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "收货地址" }
    ]
  },
  {
    id: "matrix-store",
    name: "门店矩阵",
    mode: "matrix",
    sheetStrategy: "first",
    headerRow: 1,
    dataStartRow: 2,
    matrixValueStartColumn: 14,
    matrixValueEndColumn: 16,
    mappings: {
      skuName: { source: "index", index: 3 },
      skuCode: { source: "index", index: 5 },
      spec: { source: "index", index: 8 },
      remark: { source: "index", index: 2 }
    }
  }
];

const cases = [
  ["12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx", "tail-info"],
  ["多门店分Sheet出库单.xlsx", "multi-sheet"],
  ["湖南仓.xlsx", "table-hunan"],
  ["门店调拨单-卡片式.xlsx", "cards"],
  ["欢乐牧场模板0430.xlsx", "matrix-store"]
];

const readWorkbook = async (fileName) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(fileURLToPath(new URL(fileName, root)));
  return book.worksheets.map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      rows[rowNumber - 1] = [];
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        const value = cell.value;
        rows[rowNumber - 1][columnNumber - 1] = value == null
          ? ""
          : typeof value === "object" && "text" in value
            ? value.text
            : typeof value === "object" && "result" in value
              ? String(value.result ?? "")
              : typeof value === "object" && "richText" in value
                ? value.richText.map((item) => item.text).join("")
              : String(value);
      });
    });
    return { name: sheet.name, rows };
  });
};

for (const [fileName, ruleId] of cases) {
  const sheets = await readWorkbook(fileName);
  const rule = rules.find((item) => item.id === ruleId);
  const rows = parseByRule(sheets, rule);
  const issues = validateRows(rows, new Set());
  const issueSummary = issues.reduce((acc, issue) => {
    acc[issue.field] = (acc[issue.field] || 0) + 1;
    return acc;
  }, {});
  const first = rows[0] || {};
  console.log(JSON.stringify({
    fileName,
    rule: rule.name,
    rows: rows.length,
    issues: issues.length,
    issueSummary,
    first: {
      storeName: first.storeName,
      receiverName: first.receiverName,
      skuCode: first.skuCode,
      skuName: first.skuName,
      quantity: first.quantity
    }
  }, null, 2));
}
