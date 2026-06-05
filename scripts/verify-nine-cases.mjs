import { parseByRule, validateRows } from "../lib/rule-engine.ts";
import { defaultRules } from "../lib/default-rules.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const root = new URL("../demos/", import.meta.url);

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

const readPdf = async (fileName) => {
  const data = new Uint8Array(readFileSync(fileURLToPath(new URL(fileName, root))));
  const doc = await getDocument({ data, disableWorker: true }).promise;
  const lines = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    lines.push(content.items.map((item) => item.str || "").join(" "));
  }
  return [{ name: fileName, rows: lines.map((line) => [line]) }];
};

const fixture = (name, rows) => [{ name, rows }];

const cases = [
  {
    name: "黎明屯配送发货单",
    source: "real",
    sheets: await readWorkbook("12.25海口龙湖天街-配送发货单PS2512220005001(1).xlsx"),
    rule: defaultRules.find((rule) => rule.id === "tail-info"),
    expectedRows: 2
  },
  {
    name: "湖南仓发货明细",
    source: "real",
    sheets: await readWorkbook("湖南仓.xlsx"),
    rule: defaultRules.find((rule) => rule.id === "table-hunan"),
    expectedRows: 167
  },
  {
    name: "欢乐牧场模板",
    source: "real",
    sheets: await readWorkbook("欢乐牧场模板0430.xlsx"),
    rule: defaultRules.find((rule) => rule.id === "matrix-store"),
    expectedRows: 10
  },
  {
    name: "黔寨寨配送单",
    source: "real",
    sheets: await readPdf("黔寨寨贵州烙锅（鞍山店）常温.pdf"),
    rule: defaultRules.find((rule) => rule.id === "pdf-text-items"),
    expectedRows: 41
  },
  {
    name: "多门店分Sheet出库单",
    source: "real",
    sheets: await readWorkbook("多门店分Sheet出库单.xlsx"),
    rule: defaultRules.find((rule) => rule.id === "multi-sheet"),
    expectedRows: 21
  },
  {
    name: "门店调拨单(卡片式)",
    source: "real",
    sheets: await readWorkbook("门店调拨单-卡片式.xlsx"),
    rule: defaultRules.find((rule) => rule.id === "cards"),
    expectedRows: 10
  },
  {
    name: "门店配送确认单",
    source: "fixture-missing-real-file",
    sheets: fixture("Word纯文本夹具", [[
      "门店：银泰店 收货人：王店长 电话：13900001111 地址：武汉银泰\n1. SKU001 | 牛肉卷 | 1kg/包 | 3\n2. SKU002 | 蘸料 | 500g/袋 | 5\n━━━\n门店：金桥店 收货人：李店长 电话：13900002222 地址：武汉金桥\n1. SKU003 | 香肠 | 2kg/包 | 2"
    ]]),
    rule: {
      id: "word-text-fixture",
      name: "Word 纯文本夹具",
      mode: "text",
      sheetStrategy: "first",
      blockPattern: "━━━",
      itemPattern: "\\d+\\.\\s*(?<skuCode>[^\\s|]+)\\s*\\|\\s*(?<skuName>[^|]+)\\|\\s*(?<spec>[^|]+)\\|\\s*(?<quantity>\\d+)",
      mappings: {
        storeName: { source: "regex", pattern: "门店：\\s*([^\\s]+)" },
        receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
        receiverPhone: { source: "regex", pattern: "电话：\\s*([0-9-]+)" },
        receiverAddress: { source: "regex", pattern: "地址：\\s*([^\\n]+)" }
      }
    },
    expectedRows: 3
  },
  {
    name: "周配送计划",
    source: "fixture-missing-real-file",
    sheets: fixture("周配送计划夹具", [
      ["门店", "周一", "周二"],
      ["银泰店", "牛肉卷x3\n蘸料x5", "香肠x2"],
      ["金桥店", "", "米粉x4\n辣椒面x1"]
    ]),
    rule: {
      id: "weekly-plan-fixture",
      name: "周配送计划夹具",
      mode: "matrix",
      sheetStrategy: "first",
      headerRow: 1,
      dataStartRow: 2,
      matrixValueStartColumn: 2,
      matrixValueEndColumn: 3,
      matrixColumnRole: "date",
      matrixRowStoreMapping: { source: "index", index: 1 },
      compoundCellPattern: "(?<skuName>[^x\\n]+)x(?<quantity>\\d+)",
      mappings: {
        skuCode: { source: "static", value: "AUTO" }
      }
    },
    expectedRows: 5
  },
  {
    name: "配送签收单(多单PDF)",
    source: "fixture-missing-real-file",
    sheets: fixture("多单PDF夹具", [[
      "配送签收单 A 收货人：王店长 电话：13900001111 地址：武汉银泰 1 SKU001 牛肉卷 1kg 件 3 ---PAGE--- 配送签收单 B 收货人：李店长 电话：13900002222 地址：武汉金桥 1 SKU002 蘸料 500g 件 5 2 SKU003 香肠 2kg 件 2"
    ]]),
    rule: {
      id: "multi-pdf-fixture",
      name: "多单 PDF 夹具",
      mode: "text",
      sheetStrategy: "first",
      blockPattern: "---PAGE---",
      itemPattern: "\\b\\d+\\s+(?<skuCode>SKU\\d+)\\s+(?<skuName>[^\\s]+)\\s+(?<spec>[^\\s]+)\\s+件\\s+(?<quantity>\\d+)\\b",
      mappings: {
        receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
        receiverPhone: { source: "regex", pattern: "电话：\\s*([0-9-]+)" },
        receiverAddress: { source: "regex", pattern: "地址：\\s*([^\\s]+)" }
      }
    },
    expectedRows: 3
  }
];

const results = cases.map((item) => {
  const rows = parseByRule(item.sheets, item.rule);
  const issues = validateRows(rows, new Set());
  return {
    name: item.name,
    source: item.source,
    rows: rows.length,
    expectedRows: item.expectedRows,
    issues: issues.length,
    pass: rows.length === item.expectedRows && issues.length === 0
  };
});

console.log(JSON.stringify({ results, failed: results.filter((item) => !item.pass) }, null, 2));
if (results.some((item) => !item.pass)) process.exitCode = 1;
