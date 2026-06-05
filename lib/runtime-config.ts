import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const splitCsv = (value: string | undefined): string[] =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];

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

const defaultAiBaseUrl = "https://openrouter.ai/api/v1/chat/completions";

const defaultAiModels = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "moonshotai/kimi-k2.6:free"
];

const getAiApiKeys = (): { values: string[]; source?: string } => {
  const openRouterKeys = splitCsv(getRuntimeValue("OPENROUTER_API_KEYS"));
  const openRouterKey = getRuntimeValue("OPENROUTER_API_KEY");
  const aihubmixKey = getRuntimeValue("AIHUBMIX_API_KEY");
  const aiKey = getRuntimeValue("AI_API_KEY");
  if (openRouterKeys.length) return { values: openRouterKeys, source: "OPENROUTER_API_KEYS" };
  if (openRouterKey) return { values: [openRouterKey], source: "OPENROUTER_API_KEY" };
  if (aihubmixKey) return { values: [aihubmixKey], source: "AIHUBMIX_API_KEY" };
  if (aiKey) return { values: [aiKey], source: "AI_API_KEY" };
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
  const aiBaseUrl = getRuntimeValue("AI_BASE_URL");
  const models = splitCsv(getRuntimeValue("AI_MODELS") || getRuntimeValue("AI_MODEL"));
  const provider = getRuntimeValue("AI_PROVIDER") || "openrouter";
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
  minuteLimit: Number(getRuntimeValue("AI_RATE_LIMIT_PER_MINUTE") || 5),
  dailyLimit: Number(getRuntimeValue("AI_DAILY_LIMIT") || 500)
});
