import { describe, expect, it } from "vitest";
import { backgroundPoolMax, getPostgresOptions, requestPoolMax } from "@/lib/db";
import { dispatcherTriggerTimeoutMs } from "@/lib/v4/http";

describe("数据库客户端配置", () => {
  it("禁用 prepared statements 以兼容 transaction pooler", () => {
    expect(getPostgresOptions()).toMatchObject({ prepare: false });
  });

  it("请求链路连接池必须大于 1，避免详情页并发轮询串行排队超时", () => {
    expect(requestPoolMax()).toBeGreaterThan(1);
    expect(getPostgresOptions().max).toBe(requestPoolMax());
  });

  it("后台调度使用独立连接池，不与请求链路共享连接", () => {
    expect(backgroundPoolMax()).toBeGreaterThanOrEqual(1);
    expect(getPostgresOptions(backgroundPoolMax()).max).toBe(backgroundPoolMax());
  });
});

describe("后台调度触发配置", () => {
  it("内部请求超时必须短于上传函数上限", () => {
    expect(dispatcherTriggerTimeoutMs()).toBeLessThanOrEqual(10_000);
  });
});
