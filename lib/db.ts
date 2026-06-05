import postgres from "postgres";

export const getDatabaseUrl = (): string | undefined =>
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

export const getSql = (): postgres.Sql | null => {
  const url = getDatabaseUrl();
  return url ? postgres(url, { ssl: "require", max: 1 }) : null;
};
