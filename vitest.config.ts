import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Concurrent Python and PowerShell cold starts can starve Windows fixtures.
    fileParallelism: process.platform !== "win32",
  },
});
