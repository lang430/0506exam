import { getSql } from "@/lib/db";
import { getAiQuotaConfig } from "@/lib/runtime-config";

const { minuteLimit, dailyLimit } = getAiQuotaConfig();
const memoryEvents: number[] = [];

export interface QuotaResult {
  allowed: boolean;
  mode: "database" | "memory";
  minuteUsed: number;
  dayUsed: number;
  minuteLimit: number;
  dailyLimit: number;
  reason?: string;
}

const pruneMemory = (now: number): void => {
  const dayAgo = now - 24 * 60 * 60 * 1000;
  while (memoryEvents.length && memoryEvents[0] < dayAgo) memoryEvents.shift();
};

export const consumeAiQuota = async (model: string): Promise<QuotaResult> => {
  const sql = getSql();
  if (!sql) {
    const now = Date.now();
    pruneMemory(now);
    const minuteUsed = memoryEvents.filter((time) => time > now - 60_000).length;
    const dayUsed = memoryEvents.length;
    if (minuteUsed >= minuteLimit) return { allowed: false, mode: "memory", minuteUsed, dayUsed, minuteLimit, dailyLimit, reason: "minute-limit" };
    if (dayUsed >= dailyLimit) return { allowed: false, mode: "memory", minuteUsed, dayUsed, minuteLimit, dailyLimit, reason: "daily-limit" };
    memoryEvents.push(now);
    return { allowed: true, mode: "memory", minuteUsed: minuteUsed + 1, dayUsed: dayUsed + 1, minuteLimit, dailyLimit };
  }

  await sql`create table if not exists ai_usage_events (
    id bigint generated always as identity primary key,
    model text not null,
    created_at timestamptz not null default now()
  )`;
  await sql`create index if not exists ai_usage_events_created_at_idx on ai_usage_events (created_at desc)`;

  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(20260605)`;
    const [counts] = await tx`
      select
        count(*) filter (where created_at >= now() - interval '1 minute')::int as minute_used,
        count(*) filter (where created_at >= date_trunc('day', now()))::int as day_used
      from ai_usage_events
    `;
    const minuteUsed = Number(counts.minute_used || 0);
    const dayUsed = Number(counts.day_used || 0);
    if (minuteUsed >= minuteLimit) return { allowed: false, mode: "database", minuteUsed, dayUsed, minuteLimit, dailyLimit, reason: "minute-limit" };
    if (dayUsed >= dailyLimit) return { allowed: false, mode: "database", minuteUsed, dayUsed, minuteLimit, dailyLimit, reason: "daily-limit" };

    await tx`insert into ai_usage_events (model) values (${model})`;
    return { allowed: true, mode: "database", minuteUsed: minuteUsed + 1, dayUsed: dayUsed + 1, minuteLimit, dailyLimit };
  });
};
