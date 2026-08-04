import ExcelJS from "exceljs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const RULE_ID = process.env.RULE_ID || "rule-loadtest-standard";

const main = async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("x");
  sheet.columns = [
    { header: "外部编码", key: "externalCode" }, { header: "收货门店", key: "storeName" },
    { header: "收件人姓名", key: "receiverName" }, { header: "收件人电话", key: "receiverPhone" },
    { header: "收件人地址", key: "receiverAddress" }, { header: "SKU物品编码", key: "skuCode" },
    { header: "SKU物品名称", key: "skuName" }, { header: "SKU发货数量", key: "quantity" },
    { header: "SKU规格型号", key: "spec" }, { header: "备注", key: "remark" }
  ];
  for (let i = 0; i < 30; i++) {
    sheet.addRow({
      externalCode: `E2E-${Date.now()}-${i}`, storeName: "E2E店", receiverName: "测试员",
      receiverPhone: "13800001111", receiverAddress: "上海市浦东新区测试路1号",
      skuCode: `SKU_${String((i % 20000) + 1).padStart(5, "0")}`, skuName: `商品${i + 1}`,
      quantity: i + 1, spec: "500g", remark: ""
    });
  }
  const buf = Buffer.from(await book.xlsx.writeBuffer());
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "application/octet-stream" }), "e2e.xlsx");
  form.append("ruleId", RULE_ID);
  const up = await fetch(`${BASE}/api/import-tasks`, { method: "POST", body: form });
  const body = await up.json();
  console.log("UPLOAD", up.status, "task", body.task_id, "upload_ms", body.upload_ms, "batches", body.total_batches);
  if (!body.task_id) { console.log("FAIL", JSON.stringify(body)); process.exit(1); }
  const id = body.task_id;
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 90000) {
    const r = await fetch(`${BASE}/api/import-tasks/${id}`);
    const d = await r.json();
    if (d.task_id) {
      last = d;
      process.stdout.write(`\r${d.status} ${d.processed_rows}/${d.total_rows} ok${d.success_rows} fail${d.failed_rows}`);
      if (["COMPLETED", "PARTIAL_SUCCESS", "FAILED"].includes(d.status)) { console.log(`\n终态 ${Math.round((Date.now() - start) / 1000)}s`); break; }
    }
    await new Promise((z) => setTimeout(z, 1000));
  }
  console.log("FINAL", JSON.stringify(last && { status: last.status, success: last.success_rows, failed: last.failed_rows, degraded: last.degraded }));
  process.exit(last && ["COMPLETED", "PARTIAL_SUCCESS"].includes(last.status) ? 0 : 2);
};
main().catch((e) => { console.error("E2E ERROR", e); process.exit(1); });
