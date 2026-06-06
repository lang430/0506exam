import ExcelJS from "exceljs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

process.env.AI_API_KEY = "";
process.env.AI_BASE_URL = "";
process.env.AI_MODEL = "";

const { POST } = await import("../app/api/ai-rules/route.ts");

const demoDir = join(process.cwd(), "demos");

const cellText = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "object" && "text" in cell) return String(cell.text ?? "");
  if (typeof cell === "object" && "result" in cell) return String(cell.result ?? "");
  if (typeof cell === "object" && Array.isArray(cell.richText)) return cell.richText.map((item) => item.text).join("");
  return String(cell);
};

const fileName = readdirSync(demoDir, { encoding: "utf8" })
  .find((name) => name.includes("卡片式") && name.endsWith(".xlsx") && !name.startsWith("~$"));
if (!fileName) throw new Error("未找到卡片式 Excel 文件");

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(join(demoDir, fileName));
const sheets = workbook.worksheets.map((sheet) => ({
  name: sheet.name,
  rows: sheet.getSheetValues().slice(1).map((row) =>
    Array.isArray(row) ? row.slice(1).map(cellText) : []
  )
}));

const response = await POST(new Request("http://localhost/api/ai-rules", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ fileName, sheets, auto: true })
}));
const body = await response.json();

const result = {
  status: response.status,
  degraded: body.degraded,
  model: body.model,
  mode: body.rule?.mode,
  boundaryPattern: body.rule?.boundaryPattern,
  parsedRows: body.parsedRows,
  error: body.error
};

console.log(JSON.stringify(result, null, 2));

if (
  !response.ok ||
  body.degraded ||
  body.model !== "structure-fallback" ||
  body.rule?.mode !== "cards" ||
  body.parsedRows !== 9
) {
  process.exit(1);
}
