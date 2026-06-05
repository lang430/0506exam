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

const defaultAiBaseUrl = "https://aihubmix.com/v1/chat/completions";

const defaultAiModels = [
  "xiaomi-mimo-v2.5-pro-free",
  "xiaomi-mimo-v2.5-free",
  "coding-glm-5.1-free",
  "coding-minimax-m2.7-free",
  "coding-minimax-m3-free",
  "coding-glm-5-free",
  "coding-step-3.7-flash-free",
  "coding-minimax-m2.5-free"
];

const getAiApiKey = (): { value?: string; source?: string } => {
  const aihubmixKey = getRuntimeValue("AIHUBMIX_API_KEY");
  const aiKey = getRuntimeValue("AI_API_KEY");
  if (aihubmixKey) return { value: aihubmixKey, source: "AIHUBMIX_API_KEY" };
  if (aiKey) return { value: aiKey, source: "AI_API_KEY" };
  return {};
};

export const getDatabaseConfig = (): { url?: string } => ({
  url: getRuntimeValue("DATABASE_URL") ||
    getRuntimeValue("POSTGRES_URL") ||
    getRuntimeValue("POSTGRES_PRISMA_URL") ||
    getRuntimeValue("POSTGRES_URL_NON_POOLING")
});

export const getAiConfig = () => {
  const apiKey = getAiApiKey();
  const aiBaseUrl = getRuntimeValue("AI_BASE_URL");
  const models = splitCsv(getRuntimeValue("AI_MODELS") || getRuntimeValue("AI_MODEL"));
  return {
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
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
