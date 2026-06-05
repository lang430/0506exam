const splitCsv = (value: string | undefined): string[] =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];

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
  if (process.env.AIHUBMIX_API_KEY) return { value: process.env.AIHUBMIX_API_KEY, source: "AIHUBMIX_API_KEY" };
  if (process.env.AI_API_KEY) return { value: process.env.AI_API_KEY, source: "AI_API_KEY" };
  return {};
};

export const getDatabaseConfig = (): { url?: string } => ({
  url: process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING
});

export const getAiConfig = () => {
  const apiKey = getAiApiKey();
  const models = splitCsv(process.env.AI_MODELS || process.env.AI_MODEL);
  return {
    apiKey: apiKey.value,
    apiKeySource: apiKey.source,
    baseUrl: process.env.AI_BASE_URL || defaultAiBaseUrl,
    models: models.length ? models : defaultAiModels,
    usingDefaultBaseUrl: !process.env.AI_BASE_URL,
    usingDefaultModels: !models.length
  };
};
