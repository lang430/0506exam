import { config } from "dotenv";
import postgres from "postgres";
import { POST } from "../app/api/orders/route.ts";

config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

if (!databaseUrl) {
  console.log(JSON.stringify({ pass: false, error: "数据库环境变量未配置" }, null, 2));
  process.exit(1);
}

const sql = postgres(databaseUrl, { ssl: "require", max: 1 });
const id = `verify-db-${Date.now()}`;

try {
  const row = {
    id,
    externalCode: `VERIFY-${Date.now()}`,
    storeName: "数据库落表验证门店",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "VERIFY-SKU",
    skuName: "数据库落表验证商品",
    quantity: 1,
    spec: "1件",
    remark: "自动化验证后清理",
    source: "verify-database-persistence",
    errors: []
  };

  const response = await POST(new Request("http://localhost/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: "verify.xlsx", ruleId: null, rows: [row] })
  }));
  const body = await response.json();

  if (!response.ok) {
    console.log(JSON.stringify({ pass: false, status: response.status, body }, null, 2));
    process.exit(1);
  }

  const orders = await sql`
    select id, batch_id, payload, external_code, sku_code
    from imported_orders
    where id = ${id}
  `;
  const batchId = orders[0]?.batch_id;
  const batches = batchId ? await sql`
    select id, total_rows, success_rows, failed_rows, status
    from import_batches
    where id = ${batchId}
  ` : [];

  const pass = orders.length === 1 &&
    batches.length === 1 &&
    orders[0].payload?.skuCode === row.skuCode &&
    Number(batches[0].total_rows) === 1 &&
    Number(batches[0].success_rows) === 1 &&
    Number(batches[0].failed_rows) === 0 &&
    batches[0].status === "submitted";

  console.log(JSON.stringify({
    pass,
    saved: body.saved,
    mode: body.mode,
    orderRows: orders.length,
    batchRows: batches.length,
    batchStatus: batches[0]?.status
  }, null, 2));

  if (!pass) process.exit(1);
} finally {
  const batchRows = await sql`select batch_id from imported_orders where id = ${id}`;
  await sql`delete from imported_orders where id = ${id}`;
  if (batchRows[0]?.batch_id) await sql`delete from import_batches where id = ${batchRows[0].batch_id}`;
  await sql.end();
}
