import { describe, expect, it, vi } from "vitest";

type QueueDepth = {
  waitingRows: number;
  pendingBatches: number;
  stuckBatches: number;
  processingBatches: number;
  readyBatches: number;
  outboxPending: number;
};

describe("队列卡死恢复", () => {
  it("卡死或无人消费的积压需要唤醒 Dispatcher，正常处理中的队列不重复唤醒", async () => {
    const monitorModule = await import("@/lib/v4/monitor") as unknown as Record<string, unknown>;
    const shouldWakeDispatcher = monitorModule.shouldWakeDispatcher as ((depth: QueueDepth) => boolean) | undefined;

    expect(shouldWakeDispatcher).toBeTypeOf("function");
    if (!shouldWakeDispatcher) return;

    expect(shouldWakeDispatcher({ waitingRows: 10_000, pendingBatches: 0, stuckBatches: 1, processingBatches: 1, readyBatches: 0, outboxPending: 0 })).toBe(true);
    expect(shouldWakeDispatcher({ waitingRows: 10_000, pendingBatches: 0, stuckBatches: 0, processingBatches: 0, readyBatches: 4, outboxPending: 0 })).toBe(true);
    expect(shouldWakeDispatcher({ waitingRows: 10_000, pendingBatches: 0, stuckBatches: 0, processingBatches: 1, readyBatches: 3, outboxPending: 0 })).toBe(false);
    expect(shouldWakeDispatcher({ waitingRows: 0, pendingBatches: 0, stuckBatches: 0, processingBatches: 0, readyBatches: 1, outboxPending: 0 })).toBe(true);
    expect(shouldWakeDispatcher({ waitingRows: 0, pendingBatches: 0, stuckBatches: 0, processingBatches: 0, readyBatches: 0, outboxPending: 0 })).toBe(false);
  });
});

describe("任务详情轮询防重入", () => {
  it("前一请求未结束时跳过重复请求，并在结束后释放", async () => {
    const pageModule = await import("@/app/tasks/[id]/page") as unknown as Record<string, unknown>;
    const runSingleFlight = pageModule.runSingleFlight as (<T>(state: { current: boolean }, operation: () => Promise<T>) => Promise<T | undefined>) | undefined;

    expect(runSingleFlight).toBeTypeOf("function");
    if (!runSingleFlight) return;

    const state = { current: false };
    let release!: () => void;
    const operation = vi.fn(() => new Promise<string>((resolve) => {
      release = () => resolve("完成");
    }));

    const first = runSingleFlight(state, operation);
    const duplicate = await runSingleFlight(state, operation);
    expect(duplicate).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe("完成");
    await runSingleFlight(state, async () => "再次执行");
    expect(state.current).toBe(false);
  });
});
