import { readFileSync } from "node:fs";

const route = readFileSync("app/api/orders/route.ts", "utf-8");

const checks = {
  noPerRowAwaitInsert: !/for\s*\(const row of rows\)[\s\S]*?await transaction`insert into imported_orders/.test(route),
  usesBulkValuesHelper: route.includes("const orderValues = rows.map") && route.includes("${transaction(chunk,"),
  normalizesUndefinedValues: route.includes("const nullableText =") && route.includes("nullableText(row.spec)") && route.includes("cleanOrderPayload"),
  chunksBulkWrites: route.includes("const insertBatchSize") && route.includes("for (let index = 0; index < orderValues.length; index += insertBatchSize)"),
  catchesPostErrorsAsJson: route.includes("catch (error)") && route.includes("运单数据写入失败")
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name) }, null, 2));
if (failed.length) process.exit(1);
