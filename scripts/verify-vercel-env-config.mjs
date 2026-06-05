import { readFileSync } from "node:fs";

const runtimeConfig = readFileSync("lib/runtime-config.ts", "utf-8");
const db = readFileSync("lib/db.ts", "utf-8");
const aiRoute = readFileSync("app/api/ai-rules/route.ts", "utf-8");
const rulesApi = readFileSync("app/api/rules/route.ts", "utf-8");
const page = readFileSync("app/page.tsx", "utf-8");
const docs = readFileSync("提交说明.md", "utf-8");

const requiredServerVars = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "OPENROUTER_API_KEYS",
  "AI_BASE_URL",
  "AI_MODELS",
  "AI_RATE_LIMIT_PER_MINUTE",
  "AI_DAILY_LIMIT"
];

const checks = {
  centralizedRuntimeConfig: runtimeConfig.includes("getDatabaseConfig") && runtimeConfig.includes("getAiConfig"),
  databaseUsesRuntimeConfig: db.includes("getDatabaseConfig") && !db.includes("process.env.POSTGRES_URL"),
  aiUsesRuntimeConfig: aiRoute.includes("getAiConfig") && !aiRoute.includes("process.env.OPENROUTER_API_KEYS"),
  openRouterConfigured: runtimeConfig.includes("OPENROUTER_API_KEYS") && runtimeConfig.includes("openrouter") && runtimeConfig.includes("https://openrouter.ai/api/v1/chat/completions"),
  aiKeyPoolConfigured: runtimeConfig.includes("apiKeys") && aiRoute.includes("apiKeyCount") && aiRoute.includes("keyIndex"),
  aiEnvKeyFallbackConfigured: runtimeConfig.includes("OPENROUTER_API_KEY_1") && runtimeConfig.includes("OPENROUTER_API_KEY_2"),
  noHardcodedOpenRouterSecrets: ![runtimeConfig, aiRoute].some((content) => /sk-or-v1-[A-Za-z0-9]+/.test(content)),
  openRouterOnly: ![runtimeConfig, aiRoute].some((content) => content.includes("AIHUBMIX") || content.includes("aihubmix")),
  openRouterAttemptLimit: aiRoute.includes("maxOpenRouterAttempts = 3") && aiRoute.includes("attemptedCount >= maxOpenRouterAttempts"),
  aiRuleNormalization: aiRoute.includes("normalizeModelRule") && aiRoute.includes("normalizeMapping") && aiRoute.includes("columnIndex"),
  aiRuleMustParseRows: aiRoute.includes("parseByRule(payload.sheets, rule)") && aiRoute.includes("model-rule-empty"),
  aiDoesNotReturnFallbackRule: !aiRoute.includes("fallbackRule(") && aiRoute.includes("degraded: true") && aiRoute.includes("status: 503"),
  aiLocalConfigSupported: runtimeConfig.includes(".env.local") && runtimeConfig.includes("readFileSync") && runtimeConfig.includes("encoding: \"utf-8\""),
  aiQuotaUsesRuntimeConfig: readFileSync("lib/ai-quota.ts", "utf-8").includes("getAiQuotaConfig"),
  noDotenvDependency: ![db, aiRoute, rulesApi, page].some((content) => content.includes("dotenv")),
  rulesPersistToDatabase: !rulesApi.includes(".data") && !rulesApi.includes("mode: \"file\"") && rulesApi.includes("parse_rules"),
  rulesReadOnlyFromDatabase: !rulesApi.includes("defaultRules") && !page.includes("useState<ParseRule[]>(defaultRules)") && !page.includes("defaultRules[0]"),
  aiConfigDiagnosticSafe: aiRoute.includes("export async function GET") && aiRoute.includes("hasApiKey") && aiRoute.includes("modelCount") && !aiRoute.includes("apiKey: apiKey"),
  noPublicSecretEnv: ![runtimeConfig, db, aiRoute, page].some((content) => /NEXT_PUBLIC_.*(KEY|SECRET|TOKEN|URL)/.test(content)),
  documentsVercelVars: requiredServerVars.every((name) => docs.includes(name)),
  aiFallbackConfigured: runtimeConfig.includes("defaultAiBaseUrl") && runtimeConfig.includes("defaultAiModels") && runtimeConfig.includes("usingDefaultModels"),
  aiCallLogsConfigured: [
    "request-start",
    "model-attempt",
    "model-response",
    "model-response-invalid-json",
    "model-invalid-json",
    "fallback"
  ].every((event) => aiRoute.includes(event))
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name), requiredServerVars }, null, 2));
if (failed.length) process.exit(1);
