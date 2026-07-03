import { normalizeOrderPayloadForResponse } from "../app/api/orders/route.ts";

const createdAt = new Date("2026-07-03T08:00:00.000Z");
const payload = {
  id: "row-1",
  externalCode: "PS2605290031",
  storeName: "测试门店",
  receiverName: "测试收件人",
  receiverPhone: "13800000000",
  receiverAddress: "测试地址",
  skuCode: "SKU-001",
  skuName: "测试商品",
  quantity: 2,
  spec: "1箱",
  remark: "接口返回归一化验证",
  source: "verify",
  errors: []
};

const normalizedFromString = normalizeOrderPayloadForResponse(JSON.stringify(payload), createdAt);
const normalizedFromObject = normalizeOrderPayloadForResponse(payload, createdAt);

const checks = {
  parsesJsonStringPayload: normalizedFromString.externalCode === payload.externalCode,
  doesNotExposeCharacterIndexes: !("0" in normalizedFromString),
  preservesObjectPayload: normalizedFromObject.skuCode === payload.skuCode,
  usesDatabaseCreatedAtAsSubmittedAt: normalizedFromString.submittedAt === createdAt.toISOString()
};

const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);

console.log(JSON.stringify({
  checks,
  failed,
  normalizedFromString
}, null, 2));

if (failed.length) process.exit(1);
