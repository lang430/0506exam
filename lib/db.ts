import postgres from "postgres";
import { getDatabaseConfig } from "@/lib/runtime-config";

export const getDatabaseUrl = (): string | undefined =>
  getDatabaseConfig().url;

export const getSql = (): postgres.Sql | null => {
  const url = getDatabaseUrl();
  return url ? postgres(url, { ssl: "require", max: 1 }) : null;
};
