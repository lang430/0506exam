import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const parseLocalEnv = (): Record<string, string> => {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return {};
  return Object.fromEntries(
    readFileSync(envPath, { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
        return [key, value];
      })
  );
};

const getLocalEnv = (): Record<string, string> => parseLocalEnv();

const getRuntimeValue = (name: string): string | undefined =>
  process.env[name] || getLocalEnv()[name];

export const getDatabaseConfig = (): { url?: string } => ({
  url: getRuntimeValue("DATABASE_URL") ||
    getRuntimeValue("POSTGRES_URL") ||
    getRuntimeValue("POSTGRES_PRISMA_URL") ||
    getRuntimeValue("POSTGRES_URL_NON_POOLING")
});

export const getAiConfig = () => {
  const apiKey = getRuntimeValue("AI_API_KEY");
  const aiBaseUrl = getRuntimeValue("AI_BASE_URL");
  const model = getRuntimeValue("AI_MODEL");
  // 逐变量诊断来源（Vercel Environment Variables 优先，.env.local 兜底）
  const envSources = {
    AI_API_KEY: process.env.AI_API_KEY ? "Environment:AI_API_KEY" : apiKey ? ".env.local:AI_API_KEY" : "missing",
    AI_BASE_URL: process.env.AI_BASE_URL ? "Environment:AI_BASE_URL" : aiBaseUrl ? ".env.local:AI_BASE_URL" : "missing",
    AI_MODEL: process.env.AI_MODEL ? "Environment:AI_MODEL" : model ? ".env.local:AI_MODEL" : "missing"
  };
  return {
    provider: "pomoai",
    apiKey,
    apiKeySource: envSources.AI_API_KEY === "missing" ? undefined : envSources.AI_API_KEY,
    envSources,
    baseUrl: aiBaseUrl,
    model,
    models: model ? [model] : [],
    usingDefaultBaseUrl: false,
    usingDefaultModels: false
  };
};

export const getAiQuotaConfig = () => ({
  minuteLimit: Number(process.env.AI_RATE_LIMIT_PER_MINUTE || 5),
  dailyLimit: Number(process.env.AI_DAILY_LIMIT || 500)
});
