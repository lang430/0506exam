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
  "AIHUBMIX_API_KEY",
  "AI_BASE_URL",
  "AI_MODELS",
  "AI_RATE_LIMIT_PER_MINUTE",
  "AI_DAILY_LIMIT"
];

const checks = {
  centralizedRuntimeConfig: runtimeConfig.includes("getDatabaseConfig") && runtimeConfig.includes("getAiConfig"),
  databaseUsesRuntimeConfig: db.includes("getDatabaseConfig") && !db.includes("process.env.POSTGRES_URL"),
  aiUsesRuntimeConfig: aiRoute.includes("getAiConfig") && !aiRoute.includes("process.env.AIHUBMIX_API_KEY"),
  noLocalEnvFileDependency: ![runtimeConfig, db, aiRoute, rulesApi, page].some((content) => content.includes(".env.local") || content.includes("dotenv")),
  rulesPersistToDatabase: !rulesApi.includes(".data") && !rulesApi.includes("mode: \"file\"") && rulesApi.includes("parse_rules"),
  rulesReadOnlyFromDatabase: !rulesApi.includes("defaultRules") && !page.includes("useState<ParseRule[]>(defaultRules)") && !page.includes("defaultRules[0]"),
  noPublicSecretEnv: ![runtimeConfig, db, aiRoute, page].some((content) => /NEXT_PUBLIC_.*(KEY|SECRET|TOKEN|URL)/.test(content)),
  documentsVercelVars: requiredServerVars.every((name) => docs.includes(name)),
  noHardcodedAiRuntimeValues: !runtimeConfig.includes("https://aihubmix.com") && !runtimeConfig.includes("coding-glm-5.1-free")
};

const failed = Object.entries(checks).filter(([, value]) => !value);
console.log(JSON.stringify({ checks, failed: failed.map(([name]) => name), requiredServerVars }, null, 2));
if (failed.length) process.exit(1);
