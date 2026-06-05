import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const splitCsv = (value: string | undefined): string[] =>
  value?.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean) ?? [];

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

const defaultAiBaseUrl = "https://www.pomoai.xyz//v1/chat/completions";
const defaultAiModel = "gpt-5.5";

export const getDatabaseConfig = (): { url?: string } => ({
  url: getRuntimeValue("DATABASE_URL") ||
    getRuntimeValue("POSTGRES_URL") ||
    getRuntimeValue("POSTGRES_PRISMA_URL") ||
    getRuntimeValue("POSTGRES_URL_NON_POOLING")
});

export const getAiConfig = () => {
  const apiKey = process.env.AI_API_KEY;
  const aiBaseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;
  return {
    provider: process.env.AI_PROVIDER || "pomoai",
    apiKey,
    apiKeySource: apiKey ? "Vercel Environment:AI_API_KEY" : undefined,
    baseUrl: aiBaseUrl || defaultAiBaseUrl,
    model: model || defaultAiModel,
    models: [model || defaultAiModel],
    usingDefaultBaseUrl: !aiBaseUrl,
    usingDefaultModels: !model
  };
};

export const getAiQuotaConfig = () => ({
  minuteLimit: Number(process.env.AI_RATE_LIMIT_PER_MINUTE || 5),
  dailyLimit: Number(process.env.AI_DAILY_LIMIT || 500)
});
