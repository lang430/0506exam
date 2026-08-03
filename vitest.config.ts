import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) }
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["tests/**/*.test.ts"],
    fileParallelism: false
  }
});
