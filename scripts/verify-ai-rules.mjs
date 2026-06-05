import ExcelJS from "exceljs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const cellText = (cell) => {
  if (cell == null) return "";
  if (typeof cell === "object" && "text" in cell) return String(cell.text ?? "");
  if (typeof cell === "object" && "result" in cell) return String(cell.result ?? "");
  if (typeof cell === "object" && Array.isArray(cell.richText)) return cell.richText.map((item) => item.text).join("");
  return String(cell);
};

const demoDir = join(process.cwd(), "demos");
const fileName = readdirSync(demoDir, { encoding: "utf8" }).find((name) => name.endsWith(".xlsx"));
if (!fileName) throw new Error("未找到 xlsx demo 文件");

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(join(demoDir, fileName));
const sheets = workbook.worksheets.slice(0, 1).map((sheet) => ({
  name: sheet.name,
  rows: sheet.getSheetValues().slice(1, 16).map((row) =>
    Array.isArray(row) ? row.slice(1).map(cellText) : []
  )
}));

const startedAt = Date.now();
const response = await fetch(process.env.AI_BASE_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.AI_API_KEY}`
  },
  body: JSON.stringify({
    model: process.env.AI_MODEL,
    messages: [
      {
        role: "system",
        content: "你是出库单导入规则生成器。只输出一个可被 JSON.parse 解析的 ParseRule JSON 对象，不要输出 Markdown。"
      },
      {
        role: "user",
        content: `根据文件快照生成规则 JSON，字段包括 name、mode、sheetStrategy、headerRow、dataStartRow、mappings、assumptions。mappings 使用 {\"source\":\"index\",\"index\":1} 或 {\"source\":\"header\",\"header\":\"表头\"}。文件快照：${JSON.stringify({ fileName, sheets }).slice(0, 8000)}`
      }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  })
});
const body = await response.text();
console.log(JSON.stringify({
  hasKey: Boolean(process.env.AI_API_KEY),
  keyLength: process.env.AI_API_KEY?.length ?? 0,
  baseUrl: process.env.AI_BASE_URL,
  model: process.env.AI_MODEL,
  status: response.status,
  ok: response.ok,
  elapsedMs: Date.now() - startedAt,
  bodyPreview: body.slice(0, 1000)
}, null, 2));
if (!response.ok) process.exit(1);
