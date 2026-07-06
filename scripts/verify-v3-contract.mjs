const contract = await import("../app/api/v1/orders/route.ts");
const detail = await import("../app/api/v1/orders/[externalCode]/route.ts");
const skuVerify = await import("../app/api/v1/orders/[externalCode]/skus/[skuCode]/verify/route.ts");

const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};

const base = "http://localhost";
const listResponse = await contract.GET(new Request(`${base}/api/v1/orders?limit=1`));
assert(listResponse.status === 200, `列表接口状态异常：${listResponse.status}`);
const listBody = await listResponse.json();
assert(Array.isArray(listBody.items), "列表接口必须返回 items 数组");
assert("serverTime" in listBody, "列表接口必须返回 serverTime");
assert("schemaVersion" in listBody, "列表接口必须返回 schemaVersion");

if (!listBody.items.length) {
  console.log(JSON.stringify({ skipped: true, reason: "V2 当前没有可验证运单数据" }, null, 2));
  process.exit(0);
}

const sample = listBody.items[0];
const sku = sample.skuItems?.[0];
assert(sample.externalCode, "样本必须有 externalCode");
assert(sku?.skuCode, "样本必须有 skuCode");

const detailResponse = await detail.GET(
  new Request(`${base}/api/v1/orders/${encodeURIComponent(sample.externalCode)}`),
  { params: Promise.resolve({ externalCode: sample.externalCode }) }
);
assert(detailResponse.status === 200, `详情接口状态异常：${detailResponse.status}`);
const detailBody = await detailResponse.json();
assert(detailBody.externalCode === sample.externalCode, "详情接口必须返回指定 externalCode");
assert(Array.isArray(detailBody.skuItems), "详情接口必须返回 skuItems");
assert(detailBody.schemaVersion, "详情接口必须返回 schemaVersion");

const verifyResponse = await skuVerify.GET(
  new Request(`${base}/api/v1/orders/${encodeURIComponent(sample.externalCode)}/skus/${encodeURIComponent(sku.skuCode)}/verify`),
  { params: Promise.resolve({ externalCode: sample.externalCode, skuCode: sku.skuCode }) }
);
assert(verifyResponse.status === 200, `SKU 校验接口状态异常：${verifyResponse.status}`);
const verifyBody = await verifyResponse.json();
assert(verifyBody.exists === true, "SKU 校验必须标记运单存在");
assert(verifyBody.belongsToOrder === true, "SKU 校验必须标记 SKU 归属当前运单");

const missingResponse = await skuVerify.GET(
  new Request(`${base}/api/v1/orders/${encodeURIComponent(sample.externalCode)}/skus/NOT-A-REAL-SKU/verify`),
  { params: Promise.resolve({ externalCode: sample.externalCode, skuCode: "NOT-A-REAL-SKU" }) }
);
const missingBody = await missingResponse.json();
assert(missingResponse.status === 200, `不存在 SKU 校验状态异常：${missingResponse.status}`);
assert(missingBody.exists === true, "不存在 SKU 校验仍应标记运单存在");
assert(missingBody.belongsToOrder === false, "不存在 SKU 不能归属当前运单");

console.log(JSON.stringify({
  checked: true,
  externalCode: sample.externalCode,
  skuCode: sku.skuCode,
  schemaVersion: detailBody.schemaVersion
}, null, 2));
