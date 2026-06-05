import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { POST } from "../app/api/ai-rules/route.ts";

const demoDir = join(process.cwd(), "demos");
const fileName = readdirSync(demoDir, { encoding: "utf8" }).find((name) => name.endsWith(".pdf"));
if (!fileName) throw new Error("未找到 PDF demo 文件");

const data = new Uint8Array(readFileSync(join(demoDir, fileName)));
const doc = await getDocument({ data, disableWorker: true }).promise;
const rows = [];
for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
  const page = await doc.getPage(pageNo);
  const content = await page.getTextContent();
  rows.push([content.items.map((item) => item.str || "").join(" ")]);
}

process.env.AI_API_KEY = "verify-only-key";
process.env.AI_BASE_URL = "https://verify.invalid/v1/chat/completions";
process.env.AI_MODEL = "verify-model";
process.env.AI_RATE_LIMIT_PER_MINUTE = "5";
process.env.AI_DAILY_LIMIT = "500";

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{
    message: {
      content: JSON.stringify({
        name: "PDF 连续文本表格规则",
        mode: "table",
        sheetStrategy: "first",
        headerRow: 1,
        dataStartRow: 2,
        mappings: {
          externalCode: { source: "regex", pattern: "单据编号：\\s*([A-Z0-9]+)" },
          storeName: { source: "regex", pattern: "收货机构：\\s*([^\\s]+)" },
          receiverName: { source: "regex", pattern: "收货人：\\s*([^\\s]+)" },
          receiverPhone: { source: "regex", pattern: "收货电话：\\s*([0-9-]+)" },
          receiverAddress: { source: "regex", pattern: "收货地址：\\s*(.+?)\\s+打印次数" },
          skuCode: { source: "header", header: "物品编码" },
          skuName: { source: "header", header: "物品名称" },
          spec: { source: "header", header: "规格型号" },
          quantity: { source: "header", header: "发货数量" }
        }
      })
    },
    finish_reason: "stop"
  }]
}), { status: 200, headers: { "Content-Type": "application/json" } });

try {
  const response = await POST(new Request("http://localhost/api/ai-rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, sheets: [{ name: fileName, rows }], auto: true })
  }));
  const body = await response.json();
  console.log(JSON.stringify({
    status: response.status,
    degraded: body.degraded,
    parsedRows: body.parsedRows,
    rule: body.rule ? {
      mode: body.rule.mode,
      hasItemPattern: Boolean(body.rule.itemPattern),
      mappingFields: Object.keys(body.rule.mappings ?? {})
    } : null,
    error: body.error,
    attempts: body.attempts?.map((attempt) => ({ ok: attempt.ok, category: attempt.category, error: attempt.error }))
  }, null, 2));
  if (!response.ok || body.degraded || body.parsedRows !== 41 || body.rule?.mode !== "text" || !body.rule?.itemPattern) {
    process.exitCode = 1;
  }
} finally {
  globalThis.fetch = originalFetch;
}
