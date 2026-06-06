import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 10000,
    exclude: [
      ...configDefaults.exclude,
      ".audit-artifacts/**",
      ".audit-code/**",
      ".claude/**",
      ".opencode/**",
      ".vscode/**",
    ],
  },
});
