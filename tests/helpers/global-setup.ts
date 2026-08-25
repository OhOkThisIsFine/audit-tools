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
//   3. REPO-ROOT BASELINE — the root's entry list as this run found it, so
//      teardown can refuse a run that ADDED anything to it. See
//      {@link unexpectedRootEntries}.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_RUN_ROOT_ENV } from "./scratch.js";
import { registerSuite, unregisterSuite, SUITE_OWNED_BUILD_ENV } from "./suiteLock.js";
import { settleTrackedChildren, type LiveChild } from "./trackedSpawn.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The repo root's entry list as `setup` found it — teardown's baseline. */
let rootEntriesAtSetup: readonly string[] = [];

export async function setup(): Promise<void> {
  rootEntriesAtSetup = readdirSync(repoRoot);
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
  // EVERY report, never the first one only: the three say different things about
  // the same run, and a fixture tree in `tests/` must not hide a leaked file in
  // the root, or a child still running, behind it.
  const problems = [
    ...inTreeFixtureProblems(),
    ...repoRootProblems(),
    ...liveChildProblems(liveChildren),
  ];
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
 * Repo-root entries a run may legitimately ADD, DECLARED rather than inferred.
 *
 * Deliberately not "whatever `.gitignore` covers": an ignore rule HIDES a leak —
 * the root's own ignore list already carries `/temp*.json`, `/part*.txt` and a
 * row of one-off script names, each one a leak somebody silenced instead of
 * fixing. A declaration states which entries are tool-owned; anything else is
 * reported by name.
 */
export const RUN_OWNED_ROOT_ENTRIES: readonly string[] = [
  ".audit-tools", // CLI artifacts, when a test drives a bin at the repo root
  ".audit-tools-profile", // the always-on vitest timing ledger
  ".tmp",
  "dist", // a suite-owned rebuild (the dev wrapper auto-builds)
  "node_modules",
];

/**
 * The root entries this run ADDED and does not own — the leak report.
 *
 * `before`/`after` are entry-name lists, so the check is a pure set difference
 * and testable without a suite. Entries that were already there are never
 * reported: the property is "a run leaves the root as it found it", not "the
 * root is clean", and a pre-existing artifact belongs to whoever made it.
 */
export function unexpectedRootEntries(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const owned = new Set([...before, ...RUN_OWNED_ROOT_ENTRIES]);
  return after
    .filter((entry) => !owned.has(entry) && !entry.endsWith(".tsbuildinfo"))
    .sort();
}

/**
 * Fail the run if it added anything to the repo root.
 *
 * THE OBSERVED SHAPE, and why the name of the file is the diagnosis: a command
 * STRING handed to a shell carries the shell's own grammar, and `cmd.exe` reads
 * `>` as a redirect anywhere in the line — including inside quoted source text —
 * while `;` `,` `=` end the target token. So a line of code or prose that merely
 * CONTAINS `>` writes an empty file named from the fragment after it:
 * `… .map((o) => o.testId);` leaves a file called `o.testId)`, and prose saying
 * `the >60s blocking worker` leaves one called `60s`. The file is empty, tracked
 * by nothing, and names its own producer — which is why this reports rather than
 * deletes it.
 *
 * A child that OUTLIVES the run writes after this check has already passed, so
 * the root delta alone cannot see it — {@link liveChildProblems} is the half
 * that does, by naming the child instead of waiting for its artifact.
 */
function repoRootProblems(): string[] {
  // No baseline means `setup` never ran, and a repo root is never empty — so an
  // empty baseline is "cannot tell", and reporting every entry in the root as
  // leaked is the one output guaranteed to be wrong.
  if (rootEntriesAtSetup.length === 0) return [];
  const leaked = unexpectedRootEntries(rootEntriesAtSetup, readdirSync(repoRoot));
  if (leaked.length === 0) return [];
  return [
    `This run ADDED ${leaked.length} entr${leaked.length === 1 ? "y" : "ies"} to the repo root:\n` +
      leaked.map((entry) => `  - ${entry}`).join("\n") +
      `\nA suite must leave the root as it found it. A name that looks like a fragment of code or ` +
      `prose is a shell-redirect artifact: some spawn handed a command STRING to a shell, so route ` +
      `it through argv (\`resolveExecArgv\` / \`parseCommandString\`, never \`shell: true\`). A name ` +
      `that looks deliberate is a test writing outside its scratch dir — root it with scratchDir() ` +
      `(tests/helpers/scratch.ts). Declare a genuinely tool-owned entry in RUN_OWNED_ROOT_ENTRIES.`,
  ];
}

/**
 * Fail the run if a child it spawned is STILL RUNNING.
 *
 * The other half of the same property, caught at the only moment it is still
 * attributable: a straggler writes into the checkout minutes after vitest
 * exits, when the run that spawned it is gone and its artifact belongs to
 * nobody. The ledger (`tests/helpers/trackedSpawn.ts`) knows which pids this run
 * started, so the report names the child and its command rather than the file it
 * will eventually leave.
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
