import ExcelJS from "exceljs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseByRule } from "../lib/rule-engine.ts";

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
  : readdirSync(demoDir, { encoding: "utf8" }).find((name) => name.endsWith(".xlsx"));
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
const contentType = response.headers.get("content-type") ?? "";
let parsedRows = 0;
let rulePreview = null;
if (response.ok && contentType.includes("application/json")) {
  const data = JSON.parse(body);
  const content = data.choices?.[0]?.message?.content ?? "{}";
  const rawRule = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  const aliases = {
    skuCode: ["skuCode", "productCode", "物品编码", "商品编码", "产品编码"],
    skuName: ["skuName", "productName", "物品名称", "商品名称", "产品名称"],
    quantity: ["quantity", "数量", "订货数量", "原订货数量", "实发数量", "配送数量"],
    spec: ["spec", "规格", "规格型号"],
    storeName: ["storeName", "门店", "收货门店", "客户", "订货方"],
    externalCode: ["externalCode", "单号", "订单号", "出库单号", "配送单号"],
    receiverName: ["receiverName", "收件人", "联系人"],
    receiverPhone: ["receiverPhone", "电话", "手机号"],
    receiverAddress: ["receiverAddress", "地址", "收货地址"],
    remark: ["remark", "备注"]
  };
  const mappings = {};
  for (const [field, names] of Object.entries(aliases)) {
    for (const name of names) {
      if (rawRule.mappings?.[name]) {
        mappings[field] = rawRule.mappings[name];
        break;
      }
    }
  }
  const rule = {
    id: "verify-ai",
    name: rawRule.name ?? "AI验证规则",
    mode: ["table", "matrix", "cards", "text"].includes(rawRule.mode) ? rawRule.mode : "table",
    sheetStrategy: rawRule.sheetStrategy === "all" || rawRule.sheetStrategy?.type === "all" ? "all" : "first",
    headerRow: Number(rawRule.headerRow || 1),
    dataStartRow: Number(rawRule.dataStartRow || 2),
    mappings,
    tailExtractions: [
      { field: "receiverName", label: "收货人" },
      { field: "receiverPhone", label: "电话" },
      { field: "receiverAddress", label: "地址" },
      { field: "storeName", label: "收货机构" }
    ]
  };
  const parsed = parseByRule(sheets, rule);
  parsedRows = parsed.length;
  rulePreview = {
    name: rule.name,
    mode: rule.mode,
    sheetStrategy: rule.sheetStrategy,
    headerRow: rule.headerRow,
    dataStartRow: rule.dataStartRow,
    mappingFields: Object.keys(rule.mappings),
    first: parsed[0] ? {
      storeName: parsed[0].storeName,
      receiverName: parsed[0].receiverName,
      receiverPhone: parsed[0].receiverPhone,
      receiverAddress: parsed[0].receiverAddress,
      skuCode: parsed[0].skuCode,
      skuName: parsed[0].skuName,
      quantity: parsed[0].quantity
    } : null
  };
}
console.log(JSON.stringify({
  hasKey: Boolean(process.env.AI_API_KEY),
  keyLength: process.env.AI_API_KEY?.length ?? 0,
  baseUrl: process.env.AI_BASE_URL,
  model: process.env.AI_MODEL,
  status: response.status,
  ok: response.ok,
  contentType,
  elapsedMs: Date.now() - startedAt,
  parsedRows,
  rulePreview,
  bodyPreview: body.slice(0, 1000)
}, null, 2));
if (!response.ok || !contentType.includes("application/json") || !parsedRows || !rulePreview?.first?.skuCode || !rulePreview?.first?.skuName || !(Number(rulePreview?.first?.quantity) > 0) || !(rulePreview?.first?.storeName || (rulePreview?.first?.receiverName && rulePreview?.first?.receiverPhone && rulePreview?.first?.receiverAddress))) process.exit(1);
