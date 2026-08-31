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
//
// ⚠ There was a third responsibility here — a REPO-ROOT BASELINE, taken in
// `setup` so `teardown` could refuse a run that added an entry to the repo root.
// It was DELETED on 2026-08-30 by owner decision, and it is not coming back
// without one. Its whole purpose was to catch empty shell-redirect artifacts,
// and its OWN creation commit (`f3cac01b`) already recorded that this suite does
// not produce them: 6,496 instrumented spawns, none carrying `>`. The producer is
// an agent session working in this shared checkout, which the teardown cannot
// attribute — five designs died proving post-hoc file→writer attribution
// unavailable — so every firing was a foreign write charged to this run. The
// diagnosis it carried now lives in docs/backlog/durable-traps.md.
//
// What remains here is deliberately narrower and is the part this suite CAN
// answer for: its own fixture leaks, and its own children.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RUN_ROOT_ENV } from "./scratch.js";
import { registerSuite, unregisterSuite, SUITE_OWNED_BUILD_ENV } from "./suiteLock.js";
import { settleTrackedChildren, type LiveChild } from "./trackedSpawn.js";

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
  // BEFORE the run root goes: the child ledger lives inside it.
  const liveChildren = await settleTrackedChildren();
  const root = process.env[TEST_RUN_ROOT_ENV];
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort; the OS temp dir is the backstop.
    }
  }
  // BOTH reports, never the first one only: the two say different things about
  // the same run, and a fixture tree in `tests/` must not hide a child that is
  // still running behind it.
  const problems = [...inTreeFixtureProblems(), ...liveChildProblems(liveChildren)];
  if (problems.length > 0) throw new Error(problems.join("\n\n"));
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
function inTreeFixtureProblems(): string[] {
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
  if (offenders.length === 0) return [];
  return [
    `Test fixtures were written INSIDE the repo tree:\n` +
      offenders.map((o) => `  - ${o}`).join("\n") +
      `\nFixture dirs must come from scratchDir() (tests/helpers/scratch.ts), which roots them ` +
      `under a per-invocation temp dir. An in-tree fixture dirties the working tree and can be ` +
      `swept into a commit by \`git add -A\`.`,
  ];
}

/**
 * Fail the run if a child it spawned is STILL RUNNING.
 *
 * Caught at the only moment it is still ATTRIBUTABLE, and that word is the whole
 * reason this check survived the 2026-08-30 deletion of the repo-root baseline:
 * the ledger (`tests/helpers/trackedSpawn.ts`) knows which pids THIS run started,
 * so the run is answering for its own children rather than guessing who wrote a
 * file. A straggler writes into the checkout minutes after vitest exits, when the
 * run that spawned it is gone and its artifact belongs to nobody — so the report
 * names the child and its command rather than the file it will eventually leave.
 *
 * REPORTS, never kills: a pid outlives the process that owned it and the OS
 * reuses it, so killing by pid can hit an unrelated process. The failing run is
 * the signal; the operator decides what to do with a named pid.
 *
 * WHAT IT REACHES, measured on win32: an ordinary child of a vitest worker is
 * reaped when the pool goes down, so it never reaches this check — the report
 * fires for a child that genuinely survives its parent, which is the `detached`
 * spawn and the `shell: true` grandchild that outlives the `cmd.exe` its parent
 * actually held. The grandchild is the one this cannot NAME: the ledger knows
 * the pid of cmd.exe, which is dead, not of what cmd.exe started.
 */
export function liveChildProblems(live: readonly LiveChild[]): string[] {
  if (live.length === 0) return [];
  return [
    `${live.length} child process${live.length === 1 ? "" : "es"} spawned by this run ${
      live.length === 1 ? "is" : "are"
    } STILL RUNNING:\n` +
      live.map((child) => `  - pid ${child.pid}: ${child.command}`).join("\n") +
      `\nAwait every child, or kill it before the test ends. On win32 a \`shell: true\` spawn makes ` +
      `cmd.exe the child, and killing cmd.exe leaves the grandchild it started — spawn through argv ` +
      `(\`resolveExecArgv\` / \`parseCommandString\`) so the process you hold is the process that runs. ` +
      `A surviving child writes into the checkout after every check here has passed, which is how an ` +
      `artifact ends up belonging to no run at all.`,
  ];
}
