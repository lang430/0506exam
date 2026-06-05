import ExcelJS from "exceljs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../app/api/ai-rules/route.ts";

const demoDir = join(process.cwd(), "demos");

const cellText = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "object" && "text" in cell) return String(cell.text ?? "");
  if (typeof cell === "object" && "result" in cell) return String(cell.result ?? "");
  if (typeof cell === "object" && Array.isArray(cell.richText)) return cell.richText.map((item) => item.text).join("");
  return String(cell);
};

const readWorkbook = async (matchText) => {
  const fileName = readdirSync(demoDir, { encoding: "utf8" })
    .find((name) => name.includes(matchText) && name.endsWith(".xlsx") && !name.startsWith("~$"));
  if (!fileName) throw new Error(`未找到 ${matchText} Excel 文件`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(demoDir, fileName));
  return {
    fileName,
    sheets: workbook.worksheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.getSheetValues().slice(1).map((row) =>
        Array.isArray(row) ? row.slice(1).map(cellText) : []
      )
    }))
  };
};

process.env.AI_API_KEY = "verify-only-key";
process.env.AI_BASE_URL = "https://verify.invalid/v1/chat/completions";
process.env.AI_MODEL = "verify-model";
process.env.AI_RATE_LIMIT_PER_MINUTE = "5";
process.env.AI_DAILY_LIMIT = "500";

const cases = [
  {
    matchText: "PS2512220005001",
    expectedRows: 2,
    aiRule: {
      name: "配送发货单普通表格规则",
      mode: "table",
      sheetStrategy: "first",
      headerRow: 4,
      dataStartRow: 5,
      mappings: {
        skuCode: { source: "header", header: "物品编码" },
        skuName: { source: "header", header: "物品名称" },
        spec: { source: "header", header: "规格型号" },
        quantity: { source: "header", header: "原订货数量" }
      }
    }
  },
  {
    matchText: "卡片式",
    expectedRows: 9,
    aiRule: {
      name: "门店调拨单普通表格规则",
      mode: "table",
      sheetStrategy: "first",
      headerRow: 7,
      dataStartRow: 8,
      mappings: {
        storeName: { source: "header", header: "调入门店" },
        receiverName: { source: "header", header: "收货人" },
        receiverPhone: { source: "header", header: "电话" },
        receiverAddress: { source: "header", header: "收货地址" },
        skuCode: { source: "header", header: "物品编码" },
        skuName: { source: "header", header: "物品名称" },
        spec: { source: "header", header: "规格" },
        quantity: { source: "header", header: "数量" }
      }
    }
  }
];

const originalFetch = globalThis.fetch;
const results = [];

try {
  for (const item of cases) {
    const { fileName, sheets } = await readWorkbook(item.matchText);
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(item.aiRule) }, finish_reason: "stop" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const response = await POST(new Request("http://localhost/api/ai-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, sheets, auto: true })
    }));
    const body = await response.json();
    results.push({
      fileName,
      status: response.status,
      degraded: body.degraded,
      parsedRows: body.parsedRows,
      mode: body.rule?.mode,
      boundaryPattern: body.rule?.boundaryPattern,
      error: body.error
    });
    if (!response.ok || body.degraded || body.parsedRows !== item.expectedRows) process.exitCode = 1;
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({ results }, null, 2));
