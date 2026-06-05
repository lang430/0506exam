import { performance } from "node:perf_hooks";
import { parseByRule, validateRows } from "../lib/rule-engine.ts";
import { defaultRules } from "../lib/default-rules.ts";

const header = ["收货机构", "配送汇总单号*", "配送单号", "物品行号*", "物品分类", "物品编码*", "物品名称", "物品品牌", "规格型号", "订货单位", "订货单位和基准单位换算率", "应发数量"];
const rows = [
  ["说明行"],
  header,
  ...Array.from({ length: 1000 }, (_, index) => [
    `测试门店 ${Math.floor(index / 5) + 1}`,
    `PSHZ${String(index).padStart(6, "0")}`,
    `PS${String(Math.floor(index / 5)).padStart(6, "0")}`,
    String(index + 1),
    "食材",
    `SKU${String(index).padStart(5, "0")}`,
    `测试物品 ${index + 1}`,
    "",
    "1kg*10袋",
    "件",
    "1件=10袋",
    "1"
  ])
];

const started = performance.now();
const parsed = parseByRule([{ name: "性能样例", rows }], defaultRules[0]);
const issues = validateRows(parsed, new Set());
const elapsed = performance.now() - started;

console.log(JSON.stringify({
  parsedRows: parsed.length,
  issues: issues.length,
  elapsedMs: Number(elapsed.toFixed(2)),
  pass: parsed.length === 1000 && issues.length === 0 && elapsed < 10000
}, null, 2));

if (parsed.length !== 1000 || issues.length !== 0 || elapsed >= 10000) {
  process.exitCode = 1;
}
