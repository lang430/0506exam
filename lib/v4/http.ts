import { NextResponse } from "next/server";
import type postgres from "postgres";
import { getSql } from "@/lib/db";
import { ensureV4Schema } from "@/lib/v4/schema";

/** V4 API 共享辅助：数据库句柄（含幂等建表）、鉴权、错误响应 */

let schemaReady = false;

export const getV4Sql = async (): Promise<postgres.Sql | null> => {
  const sql = getSql();
  if (!sql) return null;
  if (!schemaReady) {
    const existing = await sql`select to_regclass('public.import_tasks') as r`;
    if (existing[0]?.r) {
      schemaReady = true;
    } else {
      await ensureV4Schema(sql);
      schemaReady = true;
    }
  }
  return sql;
};

export const dbUnavailable = () =>
  NextResponse.json({ error: "数据库未配置，V4 导入链路不可用" }, { status: 503 });

export const badRequest = (error: string) =>
  NextResponse.json({ error }, { status: 400 });

export const notFound = (error: string) =>
  NextResponse.json({ error }, { status: 404 });

/** 内部调度端点鉴权：DISPATCHER_TOKEN 共享密钥（Vercel 环境变量） */
export const verifyDispatcherToken = (request: Request): boolean => {
  const expected = process.env.DISPATCHER_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token === expected;
};

export const batchSize = (): number =>
  Math.max(100, Number(process.env.V4_BATCH_SIZE || 1000));
