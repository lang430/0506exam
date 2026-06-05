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

const localEnv = parseLocalEnv();

const getRuntimeValue = (name: string): string | undefined =>
  process.env[name] || localEnv[name];

const getLocalValue = (name: string): string | undefined => localEnv[name];

const defaultAiBaseUrl = "https://openrouter.ai/api/v1/chat/completions";

const defaultAiModels = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "moonshotai/kimi-k2.6:free"
];

const getAiApiKeys = (): { values: string[]; source?: string } => {
  const openRouterKeys = [
    ...splitCsv(getLocalValue("OPENROUTER_API_KEYS")),
    ...splitCsv(getLocalValue("OPENROUTER_API_KEY")),
    ...splitCsv(getLocalValue("OPENROUTER_API_KEY_1")),
    ...splitCsv(getLocalValue("OPENROUTER_API_KEY_2"))
  ];
  if (openRouterKeys.length) return { values: openRouterKeys, source: ".env.local:OPENROUTER_API_KEYS" };
  return { values: [] };
};

export const getDatabaseConfig = (): { url?: string } => ({
  url: getRuntimeValue("DATABASE_URL") ||
    getRuntimeValue("POSTGRES_URL") ||
    getRuntimeValue("POSTGRES_PRISMA_URL") ||
    getRuntimeValue("POSTGRES_URL_NON_POOLING")
});

export const getAiConfig = () => {
  const apiKeys = getAiApiKeys();
  const aiBaseUrl = getLocalValue("AI_BASE_URL");
  const models = splitCsv(getLocalValue("AI_MODELS") || getLocalValue("AI_MODEL"));
  const provider = getLocalValue("AI_PROVIDER") || "openrouter";
  return {
    provider,
    apiKey: apiKeys.values[0],
    apiKeys: apiKeys.values,
    apiKeySource: apiKeys.source,
    baseUrl: aiBaseUrl || defaultAiBaseUrl,
    models: models.length ? models : defaultAiModels,
    usingDefaultBaseUrl: !aiBaseUrl,
    usingDefaultModels: !models.length
  };
};

export const getAiQuotaConfig = () => ({
  minuteLimit: Number(getLocalValue("AI_RATE_LIMIT_PER_MINUTE") || 5),
  dailyLimit: Number(getLocalValue("AI_DAILY_LIMIT") || 500)
});
