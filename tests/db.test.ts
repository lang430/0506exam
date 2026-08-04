import { describe, expect, it } from "vitest";
import { getPostgresOptions } from "@/lib/db";
import { dispatcherTriggerTimeoutMs } from "@/lib/v4/http";

describe("数据库客户端配置", () => {
  it("禁用 prepared statements 以兼容 transaction pooler", () => {
    expect(getPostgresOptions()).toMatchObject({
      prepare: false,
      max: 1
    });
  });
});

describe("后台调度触发配置", () => {
  it("内部请求超时必须短于上传函数上限", () => {
    expect(dispatcherTriggerTimeoutMs()).toBeLessThanOrEqual(10_000);
  });
});
