import { readFileSync } from "node:fs";

const page = readFileSync("app/page.tsx", "utf-8");

const checks = {
  uploadDoesNotAutoMatchSavedRules: !page.includes("parseWithReusableRule(nextSheets") && !page.includes("已有规则未命中，正在调用 AI 生成规则"),
  uploadGeneratesAiDraft: page.includes("文件已读取，正在调用 AI 生成推荐规则") && page.includes("await generateRule(nextSheets, file.name, true, true)"),
  aiFailureDoesNotSilentlyUseExistingRule: !page.includes("parseWithExistingRule(sourceSheets"),
  previewParsesEditorDraft: page.includes("const rule = JSON.parse(ruleText) as ParseRule") && page.includes("parseByRule(sheets, rule)"),
  previewSelectsDraftRule: page.includes("setSelectedRuleId(rule.id)") && page.includes("试解析完成")
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name) }, null, 2));
if (failed.length) process.exit(1);
