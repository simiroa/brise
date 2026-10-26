import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "strip-shebang",
      transform(code) {
        if (code.startsWith("#!")) {
          return { code: code.replace(/^#![^\n]*/, "// shebang"), map: null };
        }
      },
    },
  ],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "cli/*.test.mjs", "scripts/*.test.mjs", "scripts/bench/*.test.mjs"],
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 10000,
  },
});
