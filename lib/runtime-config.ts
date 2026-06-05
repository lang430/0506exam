const splitCsv = (value: string | undefined): string[] =>
  value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];

export const getDatabaseConfig = (): { url?: string } => ({
  url: process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING
});

export const getAiConfig = () => {
  const models = splitCsv(process.env.AI_MODELS || process.env.AI_MODEL);
  return {
    apiKey: process.env.AIHUBMIX_API_KEY,
    baseUrl: process.env.AI_BASE_URL,
    models
  };
};
