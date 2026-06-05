import { readFileSync } from "node:fs";
import { defaultRules } from "../lib/default-rules.ts";

const page = readFileSync("app/page.tsx", "utf-8");
const css = readFileSync("app/globals.css", "utf-8");
const db = readFileSync("database.sql", "utf-8");
const ordersApi = readFileSync("app/api/orders/route.ts", "utf-8");
const aiQuota = readFileSync("lib/ai-quota.ts", "utf-8");
const runtimeConfig = readFileSync("lib/runtime-config.ts", "utf-8");

const checks = {
  nextAppRouter: readFileSync("app/layout.tsx", "utf-8").includes("metadata"),
  manualRuleSelection: page.includes("select value={selectedRuleId}") && page.includes("setSelectedRuleId"),
  createEditDeleteCopyRules: ["新建规则", "保存", "删除", "复制"].every((text) => page.includes(text)),
  uploadFormats: [".xlsx", ".xls", ".docx", ".pdf"].every((text) => page.includes(text)),
  dragAndDropUpload: page.includes("onDragOver") && page.includes("onDrop") && page.includes("handleDrop"),
  pdfWorkerConfigured: page.includes("GlobalWorkerOptions.workerSrc") && page.includes("pdf.worker"),
  progressCount: page.includes("progressText"),
  fixedHeaderAndHorizontalScroll: css.includes("position: sticky") && css.includes("overflow: auto"),
  inlineEdit: page.includes("data-grid-cell"),
  addAndDeleteRows: page.includes("新增行") && page.includes("deletePreviewRow"),
  fullErrorList: page.includes("已全部列出") && !page.includes("issues.slice(0, 30)"),
  previewPagination: page.includes("previewPage") && page.includes("totalPreviewPages") && page.includes("每页 {previewPageSize} 行") && !page.includes("加载更多"),
  realtimeAiRuleGeneration: page.includes("parseWithReusableRule(nextSheets") && page.includes("已有规则未命中，正在调用 AI 生成规则") && !page.includes("正在实时调用 AI 生成规则"),
  aiRuleParsesWithoutDatabase: page.includes("parseByRule(sourceSheets, rule)") && page.includes("请预览确认后点击保存"),
  aiRulesRequireUserConfirmation: page.includes("setRuleText(JSON.stringify(rule, null, 2))") && page.includes("saveRuleRemote(rule)") && !page.includes("const savedData = await saveRuleRemote(rule)"),
  degradedAiRulesNotSaved: page.includes("isDegradedAiRule") && page.includes("aiData.degraded") && page.includes("degraded: true"),
  exportExcel: page.includes("万能导入预览结果.xlsx"),
  submitSummary: page.includes("成功 ${successCount} 条，失败 ${failureCount} 条"),
  databaseTables: ["parse_rules", "import_batches", "imported_orders", "ai_usage_events"].every((text) => db.includes(text)),
  ordersPersistToDatabase: !page.includes("localStorage") && !page.includes("本地暂存") && !ordersApi.includes("local-demo") && ordersApi.includes("import_batches") && ordersApi.includes("imported_orders"),
  unsavedAiRuleCanSubmit: ordersApi.includes("requestedRuleId") && ordersApi.includes("validRuleId") && ordersApi.includes("select id from parse_rules where id") && ordersApi.includes("values (${Array.isArray(payload) ? null : payload.fileName ?? null}, ${validRuleId}"),
  historyTableAndFilters: page.includes("historyFilters") && page.includes("history-table") && ["外部编码", "收件人", "开始日期", "结束日期", "模糊查询"].every((text) => page.includes(text)),
  clearImportedOrders: page.includes("clearImportedOrders") && ordersApi.includes("export async function DELETE") && ordersApi.includes("delete from imported_orders") && ordersApi.includes("delete from import_batches"),
  clearPreviewAfterSubmit: page.includes("setRows([])") && page.includes("setSheets([])") && page.includes("setFileName(\"\")") && page.includes("提交完成，已清空当前导入预览"),
  loadingState: page.includes("loading-overlay") && page.includes("aria-busy={busy}") && css.includes(".spinner"),
  toastStates: page.includes("toastKind") && page.includes("setToastKind") && css.includes(".status.success") && css.includes(".status.error"),
  preventDuplicateClicks: page.includes("if (busy) return") && page.includes("disabled={!rows.length || busy}") && page.includes("disabled={busy}"),
  emptyStatePlaceholder: page.includes("empty-state") && page.includes("empty-illustration") && css.includes(".empty-state"),
  transitionAnimations: css.includes("@keyframes") && css.includes("fadeIn") && css.includes("toastIn"),
  aiRateLimit: db.includes("ai_usage_events") && aiQuota.includes("getAiQuotaConfig") && runtimeConfig.includes("AI_RATE_LIMIT_PER_MINUTE") && runtimeConfig.includes("AI_DAILY_LIMIT"),
  defaultRulesCoverAvailableDemos: defaultRules.length >= 6,
  pdfRule: defaultRules.some((rule) => rule.id === "pdf-text-items"),
  matrixRule: defaultRules.some((rule) => rule.mode === "matrix"),
  cardRule: defaultRules.some((rule) => rule.mode === "cards"),
  textRule: defaultRules.some((rule) => rule.mode === "text")
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name) }, null, 2));
if (failed.length) process.exitCode = 1;
