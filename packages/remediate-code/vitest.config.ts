import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
