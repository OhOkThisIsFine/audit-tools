import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { vitestIncludeGlobs } from "./tests/helpers/testFileContract.js";
// Unlike `reporters` below, `sequence.sequencer` does NOT resolve a string module
// path — vitest constructs the value it is given (`new Sequencer(ctx)`), so this
// must be the imported class itself.
import VitestDurationSequencer from "./scripts/shared/vitest-sequencer.mjs";

// Single-package layout: one vitest runner for all three areas.
// remediate = `.test.ts`; audit + shared admit `.test.mjs` AND `.test.ts` while
// the file-by-file conversion is in flight. The include globs are DERIVED from
// `tests/helpers/testFileContract.ts` — the same rule list the visibility guard
// (`tests/shared/test-suite-visibility.test.ts`) enforces against the tree, so a
// test file the runner cannot see is a red test, never a silent green.
const sharedSrc = fileURLToPath(new URL("./src/shared", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^audit-tools\/shared\/(.*)$/, replacement: `${sharedSrc}/$1` },
      { find: /^audit-tools\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
  test: {
    include: vitestIncludeGlobs(),
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
    sequence: {
      sequencer: VitestDurationSequencer,
    },
  },
});
