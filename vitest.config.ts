import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Single-package layout: one vitest runner for all three areas.
// remediate = `.test.ts`; audit + shared = `.test.mjs` (migrated off node:test).
const sharedSrc = fileURLToPath(new URL("./src/shared", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^audit-tools\/shared\/(.*)$/, replacement: `${sharedSrc}/$1` },
      { find: /^audit-tools\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    include: [
      "tests/remediate/**/*.test.ts",
      "tests/audit/**/*.test.mjs",
      "tests/shared/**/*.test.mjs",
    ],
    // Machine-global state-dir hermeticity: point AUDIT_CODE_STATE_DIR at a
    // per-worker temp dir so no test (in-process or spawned CLI) reads/writes the
    // box's live ~/.audit-code. See tests/helpers/state-dir-setup.mjs.
    setupFiles: ["tests/helpers/state-dir-setup.mjs"],
    // Runs ONCE per invocation, before any worker forks: publishes the
    // per-invocation fixture root (AUDIT_TOOLS_TEST_RUN_ROOT, consumed by
    // tests/helpers/scratch.ts) and takes the checkout-scoped lock that makes a
    // second concurrent vitest — or a dist rebuild mid-suite — fail fast instead
    // of silently corrupting both runs' results.
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Always-on timing profile: default console reporter + the standing per-file
    // timing reporter (scripts/shared/vitest-timing-reporter.mjs) that persists a
    // ledger under .audit-tools-profile/ and a CI job-summary table. Profiling the
    // suite is a standing feature, not an opt-in flag.
    reporters: ["default", "./scripts/shared/vitest-timing-reporter.mjs"],
    // Audit integration tests spawn real subprocesses (audit-code CLI round-trips)
    // and can run for well over a minute; node:test had no per-test timeout, so
    // the ceiling is generous. Remediate/shared unit tests finish far under it.
    testTimeout: 120000,
    hookTimeout: 60000,
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
