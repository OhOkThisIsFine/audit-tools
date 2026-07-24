// Vitest globalSetup: per-invocation fixture root + running-suite registration.
//
// Runs ONCE per `vitest` invocation, before any worker forks, and is the only
// seam both entry points share — `npm test` (through
// scripts/shared/run-vitest-gate.mjs) and a bare `npx vitest run tests/…`. The
// gate wrapper is deliberately NOT the home for this: the corruption incident on
// record was a targeted `npx vitest` started while a full-suite run was in
// flight, which never touches the wrapper.
//
//   1. RUN ROOT — a fresh temp dir published on AUDIT_TOOLS_TEST_RUN_ROOT.
//      Workers inherit process.env, so every file in this run shares it while no
//      two runs can see each other's fixtures. See tests/helpers/scratch.ts.
//
//   2. REGISTRATION — this run is recorded as live so a `tsc` emit can refuse to
//      rewrite dist/ underneath it (scripts/shared/guard-no-suite-running.mjs).
//      Registration deliberately never REFUSES a second suite: per-invocation
//      roots already make concurrent suites safe, and refusing them would break
//      ordinary parallel work for a hazard that no longer exists. See
//      tests/helpers/suiteLock.ts for the full rationale.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RUN_ROOT_ENV } from "./scratch.js";
import { registerSuite, unregisterSuite, SUITE_OWNED_BUILD_ENV } from "./suiteLock.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function setup(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "audit-tools-tests-"));
  process.env[TEST_RUN_ROOT_ENV] = root;
  // Marks every descendant of this run. Workers inherit process.env and the
  // spawn helpers pass it on, so a build the SUITE itself triggers — the dev
  // wrapper's auto-rebuild, which several tests exercise — is exempt from the
  // prebuild guard. The guard exists to stop an OPERATOR rebuilding dist/ from
  // another shell mid-run; a build the suite asked for is its own business.
  process.env[SUITE_OWNED_BUILD_ENV] = "1";
  registerSuite(repoRoot);
}

export async function teardown(): Promise<void> {
  unregisterSuite(repoRoot);
  const root = process.env[TEST_RUN_ROOT_ENV];
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort; the OS temp dir is the backstop.
    }
  }
  assertNoInTreeFixtures();
}

/**
 * Fail the run if any test wrote a fixture tree back into `tests/`.
 *
 * This replaces the old `.gitignore` stopgap for `tests/remediate/.test-` dirs. An
 * ignore rule HIDES the regression: residue accumulates unseen, working-tree
 * cleanliness silently becomes a function of whether tests have run, and one
 * `git add -A` sweeps it into a commit — including as `AD` phantom deletions
 * once a later run removes a dir a previous one staged. Exactly one such file
 * (`tests/remediate/.test-plan-artifacts/not-findings.json`) reached the repo
 * that way and survived a monorepo collapse referenced by nothing.
 *
 * Checked here rather than in a test file because it must observe the state
 * AFTER every test has finished — a test asserting this mid-run would race the
 * files still using their fixtures.
 */
function assertNoInTreeFixtures(): void {
  const testsDir = join(repoRoot, "tests");
  const offenders: string[] = [];
  // Both depths: `tests/.test-x` (a helper resolving against tests/ itself) and
  // `tests/<area>/.test-x` (the per-file convention). Two levels is enough —
  // every fixture root is declared at a file's top level, never nested deeper.
  for (const area of readdirSync(testsDir, { withFileTypes: true })) {
    if (!area.isDirectory()) continue;
    if (area.name.startsWith(".test-")) {
      offenders.push(`tests/${area.name}`);
      continue;
    }
    for (const entry of readdirSync(join(testsDir, area.name), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(".test-")) {
        offenders.push(`tests/${area.name}/${entry.name}`);
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Test fixtures were written INSIDE the repo tree:\n` +
        offenders.map((o) => `  - ${o}`).join("\n") +
        `\nFixture dirs must come from scratchDir() (tests/helpers/scratch.ts), which roots them ` +
        `under a per-invocation temp dir. An in-tree fixture dirties the working tree and can be ` +
        `swept into a commit by \`git add -A\`.`,
    );
  }
}
