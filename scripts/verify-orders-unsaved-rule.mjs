import { POST } from "../app/api/orders/route.ts";
import { getSql } from "../lib/db.ts";

const sql = getSql();
if (!sql) {
  console.log(JSON.stringify({ skipped: true, reason: "数据库未配置" }, null, 2));
  process.exit(0);
}

const row = {
  id: crypto.randomUUID(),
  externalCode: "VERIFY-UNSAVED-RULE",
  storeName: "测试门店",
  receiverName: "",
  receiverPhone: "",
  receiverAddress: "",
  skuCode: "SKU-VERIFY",
  skuName: "验证商品",
  quantity: 1,
  spec: "",
  remark: "",
  source: "verify",
  errors: []
};

const response = await POST(new Request("http://localhost/api/orders", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    fileName: "verify.xlsx",
    ruleId: crypto.randomUUID(),
    rows: [row]
  })
}));
const body = await response.json();
const batchRows = body.batchId
  ? await sql`select rule_id from import_batches where id = ${body.batchId}`
  : [];

console.log(JSON.stringify({
  status: response.status,
  saved: body.saved,
  failed: body.failed,
  batchId: body.batchId,
  storedRuleId: batchRows[0]?.rule_id ?? null,
  error: body.error
}, null, 2));

if (body.batchId) {
  await sql`delete from imported_orders where batch_id = ${body.batchId}`;
  await sql`delete from import_batches where id = ${body.batchId}`;
}
await sql.end({ timeout: 1 });

if (!response.ok || body.saved !== 1 || batchRows[0]?.rule_id !== null) process.exit(1);
