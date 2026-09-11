/**
 * ONE git-index probe per deterministic fold.
 *
 * `runSingleAdvanceStep` probes the git index on every obligation execution —
 * up to `MAX_DRAIN_STEPS` `git ls-files` spawns for a single `next-step` call —
 * over a value that cannot move between them. The probe is memoized on the FOLD
 * (`ScopeIndexMemo`), so the drain spawns it once.
 *
 * Mechanism follows `one-lock-hold-per-next-step.test.ts`: a module mock of
 * `audit-tools/shared` wrapping the one `runTrackedAsync` the probe reaches for.
 * The wrapper is COUNT-ONLY — it delegates to the real implementation, so the
 * fold still runs against a real git repo and the probe's answer is real.
 *
 * ⚠ The assertion is not "the probe ran once" alone: that would also pass if the
 * probe stopped being called at all, or if the whole branch were skipped. The
 * run is verified to have DRAINED (several obligations executed) and the probe's
 * answer is verified to have LANDED on the manifest — so the count is a count of
 * a working probe, not of a dead one.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
// The window-hidden wrapper, per INV-WH — a test file never imports a raw
// spawn/exec entry point from node:child_process (see
// tests/shared/shared-tests-invariants.test.mjs).
import { execFileSyncHidden } from "../helpers/spawn.mjs";

const counter = vi.hoisted(() => ({ gitLsFilesSpawns: 0 }));

vi.mock("audit-tools/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("audit-tools/shared")>();
  const wrapped = async (
    command: readonly string[],
    ...rest: unknown[]
  ): Promise<unknown> => {
    // Scoped to the INDEX PROBE's own spawn, by the argv AND the frame.
    // `git ls-files --recurse-submodules` alone is not the probe's signature:
    // the grounding corpus (`enumerateTrackedFilePaths`) and the disposition's
    // untracked rule (`evaluateTrackedFiles`) issue the identical argv, and both
    // run inside this fold. Counting the argv alone would report those two as
    // extra "probes" and make the test demand a spawn count the fix cannot
    // deliver — which is exactly the false RED it produced first.
    if (
      command[0] === "git" &&
      command[1] === "ls-files" &&
      String(new Error().stack).includes("scopeIndexBaseline")
    ) {
      counter.gitLsFilesSpawns += 1;
    }
    return (actual.runTrackedAsync as (...args: unknown[]) => Promise<unknown>)(
      command,
      ...rest,
    );
  };
  return {
    ...actual,
    runTrackedAsync: wrapped as typeof actual.runTrackedAsync,
  };
});

const { GATE_LANES, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { submissionsDir } = await import("../../src/shared/io/auditToolsPaths.js");
const { runDeterministicForNextStep } = await import(
  "../../src/audit/cli/nextStepCommand.js"
);
const { ensureSupervisorDirs } = await import("../../src/audit/io/runArtifacts.js");
const { loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

/**
 * The batch-deterministic-block fixture — the longest guaranteed deterministic
 * drain in the suite, so a per-obligation probe has many obligations to fire on.
 * A REAL git repo (the probe shells out to git; outside a work tree it returns
 * null and would never spawn).
 */
async function writeFixture(root: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileSyncHidden("git", args, { cwd: root, stdio: "ignore" });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "scope-index-probe-fixture",
        version: "0.0.0",
        scripts: { test: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "src", "index.ts"),
    "export function hello(): string {\n  return 'hello';\n}\n",
  );
  await writeFile(
    join(root, "src", "utils.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
  );
  git("init", "--quiet");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
}

test("one next-step deterministic fold spawns the git-index probe once", async () => {
  await withTempDir("audit-code-scope-probe-", async (root) => {
    await writeFixture(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await ensureSupervisorDirs(artifactsDir);

    // Pre-satisfy the critical-flow fallback host gate so the fold runs the
    // whole deterministic block rather than pausing early.
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.critical_flow_fallback),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
    );

    counter.gitLsFilesSpawns = 0;
    const result = await runDeterministicForNextStep({
      root,
      artifactsDir,
      selfCliPath: "audit-code",
      timeoutMs: 30_000,
      narrativeEnabled: false,
      analyzers: {
        typescript: "skip",
        python: "skip",
        css: "skip",
        html: "skip",
        sql: "skip",
      },
      graphLlmEdgeReasoning: false,
    });

    // The fold must still reach its ordinary halt: this test constrains how
    // often the probe is SPAWNED, never whether the drain happens.
    expect(result.kind, `fold halted at "${result.kind}"`).toBe("confirm_intent");

    // A dead probe would satisfy "spawned once" trivially, so the answer is
    // checked to have landed on the persisted manifest.
    const bundle = await loadArtifactBundle(artifactsDir);
    expect(
      bundle.repo_manifest?.scope_index_key,
      "the probe's key must reach repo_manifest.json — otherwise this counts a dead probe",
    ).toBeTruthy();

    expect(
      counter.gitLsFilesSpawns,
      `one deterministic fold = ONE git-index probe (drained ${String(result.kind)})`,
    ).toBe(1);
  });
});
