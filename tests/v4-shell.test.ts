import { afterEach, describe, expect, it, vi } from "vitest";
import { startQueueHealthPolling } from "@/app/v4-shell";

describe("顶部队列状态刷新", () => {
  afterEach(() => vi.useRealTimers());

  it("挂载时立即加载，并每 3 秒刷新一次", async () => {
    vi.useFakeTimers();
    const load = vi.fn();
    const stop = startQueueHealthPolling(load);

    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
