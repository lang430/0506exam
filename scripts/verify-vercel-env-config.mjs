import { readFileSync } from "node:fs";

const runtimeConfig = readFileSync("lib/runtime-config.ts", "utf-8");
const db = readFileSync("lib/db.ts", "utf-8");
const aiRoute = readFileSync("app/api/ai-rules/route.ts", "utf-8");
const rulesApi = readFileSync("app/api/rules/route.ts", "utf-8");
const page = readFileSync("app/page.tsx", "utf-8");
const docs = readFileSync("SUBMISSION-NOTES.md", "utf-8");

const requiredDatabaseVars = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING"
];

const requiredAiVars = [
  "AI_API_KEY",
  "AI_BASE_URL",
  "AI_MODEL",
  "AI_RATE_LIMIT_PER_MINUTE",
  "AI_DAILY_LIMIT"
];

const checks = {
  centralizedRuntimeConfig: runtimeConfig.includes("getDatabaseConfig") && runtimeConfig.includes("getAiConfig"),
  databaseUsesRuntimeConfig: db.includes("getDatabaseConfig") && !db.includes("process.env.POSTGRES_URL"),
  aiUsesRuntimeConfig: aiRoute.includes("getAiConfig") && runtimeConfig.includes("process.env.AI_API_KEY"),
  aiUsesVercelEnvironment: runtimeConfig.includes("process.env.AI_API_KEY") &&
    runtimeConfig.includes("process.env.AI_BASE_URL") &&
    runtimeConfig.includes("process.env.AI_MODEL") &&
    !runtimeConfig.includes("getLocalValue") &&
    !runtimeConfig.includes("OPENROUTER_API_KEYS") &&
    !runtimeConfig.includes("AI_MODELS"),
  aiSingleProviderConfigured: docs.includes("https://www.pomoai.xyz/v1/chat/completions") && docs.includes("gpt-5.5"),
  aiSingleModelOnly: aiRoute.includes("maxAiAttempts = 3") && aiRoute.includes("const maxAttempts = maxAiAttempts") && aiRoute.includes("for (let attemptIndex = 0; attemptIndex < maxAttempts") && !aiRoute.includes("keyIndex"),
  noHardcodedAiSecrets: ![runtimeConfig, aiRoute].some((content) => /sk-(or-v1-)?[A-Za-z0-9_-]{20,}/.test(content)),
  noLegacyAiProviders: ![runtimeConfig, aiRoute, page, docs].some((content) => content.includes("AIHUBMIX") || content.includes("aihubmix") || content.includes("OpenRouter") || content.includes("openrouter")),
  aiRuleNormalization: aiRoute.includes("normalizeModelRule") && aiRoute.includes("normalizeMapping") && aiRoute.includes("columnIndex"),
  aiRuleMustParseRows: aiRoute.includes("parseByRule(payload.sheets, rule)") && aiRoute.includes("model-rule-empty") && aiRoute.includes("validateRows(parsedRows, new Set())"),
  aiDoesNotReturnFallbackRule: !aiRoute.includes("fallbackRule(") && aiRoute.includes("degraded: true") && aiRoute.includes("status: 503"),
  aiEnvironmentConfigSupported: runtimeConfig.includes("process.env.AI_API_KEY") && runtimeConfig.includes("process.env.AI_BASE_URL") && runtimeConfig.includes("process.env.AI_MODEL"),
  aiQuotaUsesRuntimeConfig: readFileSync("lib/ai-quota.ts", "utf-8").includes("getAiQuotaConfig"),
  noDotenvDependency: ![db, aiRoute, rulesApi, page].some((content) => content.includes("dotenv")),
  rulesPersistToDatabase: !rulesApi.includes(".data") && !rulesApi.includes("mode: \"file\"") && rulesApi.includes("parse_rules"),
  rulesReadOnlyFromDatabase: !rulesApi.includes("defaultRules") && !page.includes("useState<ParseRule[]>(defaultRules)") && !page.includes("defaultRules[0]"),
  aiConfigDiagnosticSafe: aiRoute.includes("export async function GET") && aiRoute.includes("hasApiKey") && aiRoute.includes("modelCount") && !aiRoute.includes("apiKey: apiKey"),
  noPublicSecretEnv: ![runtimeConfig, db, aiRoute, page].some((content) => /NEXT_PUBLIC_.*(KEY|SECRET|TOKEN|URL)/.test(content)),
  documentsDatabaseVars: requiredDatabaseVars.every((name) => docs.includes(name)),
  documentsAiVars: requiredAiVars.every((name) => docs.includes(name)) && docs.includes("Vercel Environment Variables"),
  aiFallbackConfigured: runtimeConfig.includes("usingDefaultBaseUrl: false") && runtimeConfig.includes("usingDefaultModels: false"),
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
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name), requiredDatabaseVars, requiredAiVars }, null, 2));
if (failed.length) process.exit(1);
