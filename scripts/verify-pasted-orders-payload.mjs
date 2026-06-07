import { readFileSync } from "node:fs";

const payload = JSON.parse(readFileSync("C:/Users/Administrator/.codex/attachments/4afc3c04-3ddc-429b-85e1-11206a2c0fb8/pasted-text.txt", "utf-8"));
const route = readFileSync("app/api/orders/route.ts", "utf-8");
const rows = Array.isArray(payload.rows) ? payload.rows : [];

const requiredFields = [
  "id",
  "externalCode",
  "storeName",
  "receiverName",
  "receiverPhone",
  "receiverAddress",
  "skuCode",
  "skuName",
  "quantity",
  "spec",
  "remark",
  "source",
  "errors"
];

const undefinedLikeFields = rows.flatMap((row, index) =>
  requiredFields
    .filter((field) => row[field] === undefined)
    .map((field) => ({ row: index + 1, field }))
);

const checks = {
  hasRows: rows.length === 21,
  requestPayloadHasNoMissingRequiredFields: undefinedLikeFields.length === 0,
  routeDoesNotPutSqlJsonFragmentInBulkValues: !route.includes("payload: transaction.json"),
  routeStringifiesPayloadBeforeBulkValues: route.includes("payload: JSON.stringify(orderPayloadJson(storedRow))")
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, rowCount: rows.length, undefinedLikeFields, failed: failed.map(([name]) => name) }, null, 2));
if (failed.length) process.exit(1);
