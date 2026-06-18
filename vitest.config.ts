import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Single-package layout: remediate's vitest suite lives under tests/remediate.
// The shared/audit suites are node:test `.mjs` files — they MUST be excluded
// here or vitest's default glob sweeps them up as a wall of false failures.
const sharedSrc = fileURLToPath(new URL("./src/shared", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^audit-tools\/shared\/(.*)$/, replacement: `${sharedSrc}/$1` },
      { find: /^audit-tools\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    include: ["tests/remediate/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 10000,
    exclude: [
      ...configDefaults.exclude,
      ".audit-artifacts/**",
      ".audit-code/**",
      ".audit-tools/**",
      ".claude/**",
      ".opencode/**",
      ".vscode/**",
    ],
  },
});
