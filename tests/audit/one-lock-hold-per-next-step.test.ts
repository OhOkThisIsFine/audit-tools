/**
 * CX-02 constraint-3 acceptance test — ONE HOLD, PERSIST ONCE.
 *
 * Counts artifact-tree lock ACQUISITIONS across one `next-step` deterministic
 * fold. Today the fold acquires and releases once per outer transition (each
 * in-fold `runAuditStep` takes the lock, and the error-recovery catch takes it
 * again); under the CX-02 one-hold shape a whole call acquires exactly ONCE.
 *
 * Mechanism: wrap `withFileLock` via a module mock of `audit-tools/shared` —
 * both `nextStepHelpers.ts` and `auditStep.ts` import the lock from that one
 * subpath — and count only acquisitions whose path ends `artifact-tree.lock`,
 * so the analyzer-policy and submission-ledger locks (different paths) cannot
 * inflate the count. The fixture is the batch-deterministic-block one: the
 * longest guaranteed deterministic drain in the suite, so the pre-collapse
 * count is not one by accident.
 *
 * What this does NOT prove (recorded in the CX-02 design record): hoisting the
 * lock into the fold driver alone turns this green while both registries and
 * both drains still stand — it is an acceptance test for constraint 3 ONLY,
 * never for the structural collapse.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const counter = vi.hoisted(() => ({ artifactTreeAcquisitions: 0 }));

vi.mock("audit-tools/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("audit-tools/shared")>();
  const wrapped = async (
    path: string,
    ...rest: unknown[]
  ): Promise<unknown> => {
    if (String(path).endsWith("artifact-tree.lock")) {
      counter.artifactTreeAcquisitions += 1;
    }
    return (actual.withFileLock as (...args: unknown[]) => Promise<unknown>)(
      path,
      ...rest,
    );
  };
  return {
    ...actual,
    withFileLock: wrapped as typeof actual.withFileLock,
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
const { withTempDir } = await import("./helpers/withTempDir.mjs");

/** The batch-deterministic-block fixture, verbatim: a tiny two-file TS repo. */
async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "one-lock-hold-fixture",
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
}

test("one next-step deterministic fold acquires the artifact-tree lock exactly once", async () => {
  await withTempDir("audit-code-one-lock-", async (root) => {
    await writeFixture(root);
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await ensureSupervisorDirs(artifactsDir);

    // Pre-satisfy the critical-flow fallback host gate (as the
    // batch-deterministic-block test does) so the fold runs the whole
    // deterministic block to confirm_intent instead of pausing early.
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    await writeFile(
      laneSubmissionPath(artifactsDir, GATE_LANES.critical_flow_fallback),
      JSON.stringify({ flows: [] }, null, 2) + "\n",
    );

    counter.artifactTreeAcquisitions = 0;
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

    // The fold must still reach its ordinary halt: this test constrains HOW the
    // work is locked, never whether it happens.
    expect(result.kind, `fold halted at "${result.kind}"`).toBe("confirm_intent");

    expect(
      counter.artifactTreeAcquisitions,
      "one deterministic fold = ONE artifact-tree lock hold (CX-02 constraint 3)",
    ).toBe(1);
  });
});
