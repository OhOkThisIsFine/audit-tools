import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

// Pause the real engine after its drain, before either production commit path.
// The actual lock, stale takeover, artifact writers and staging remain in use.
const pause = vi.hoisted(() => ({
  drained: undefined as undefined | ((bundle: ArtifactBundle) => Promise<void>),
  beforeDrain: undefined as undefined | ((bundle: ArtifactBundle) => void),
  fail: false,
}));
vi.mock("audit-tools/shared", async (original) => {
  const actual = await original<typeof import("audit-tools/shared")>();
  return { ...actual, advance: (async (...args: Parameters<typeof actual.advance>) => {
    pause.beforeDrain?.(args[1] as ArtifactBundle);
    const result = await actual.advance(...args);
    await pause.drained?.(result.state as ArtifactBundle);
    if (pause.fail) throw new Error("injected dispatch failure");
    return result;
  }) as typeof actual.advance };
});
vi.mock("../../src/shared/io/fileLock.js", async (original) => {
  const actual = await original<typeof import("../../src/shared/io/fileLock.js")>();
  return { ...actual, withFileLock: ((...args: Parameters<typeof actual.withFileLock>) => {
    // Model a missed heartbeat deterministically, without waiting thirty seconds
    // or racing the timer against the forced stale mtime below.
    if (args[0].endsWith("artifact-tree.lock")) args[4] = { heartbeatIntervalMs: 60_000 };
    return actual.withFileLock(...args);
  }) as typeof actual.withFileLock };
});

const { runDeterministicForNextStep } = await import("../../src/audit/cli/nextStepCommand.js");
const { withArtifactTreeHold } = await import("../../src/shared/io/artifactTreeHold.js");
const { artifactTreeLockPath, submissionsDir } = await import("../../src/shared/io/auditToolsPaths.js");
const { STALE_LOCK_MS } = await import("../../src/shared/io/fileLock.js");
const { GATE_LANES, laneSubmissionPath } = await import("../../src/audit/cli/laneSubmissions.js");
const { commitFold, createFoldTransaction, recoverStagedSubmissions, submissionStagingDir } = await import("../../src/audit/cli/foldTransaction.js");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

afterEach(() => { pause.drained = undefined; pause.beforeDrain = undefined; pause.fail = false; });

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(root: string) {
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export const example = 1;\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fold-lock-ownership", version: "0.0.0" }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  await mkdir(submissionsDir(artifactsDir), { recursive: true });
  const lane = GATE_LANES.critical_flow_fallback;
  const boundPath = laneSubmissionPath(artifactsDir, lane);
  const submitted = JSON.stringify({ flows: [] }, null, 2) + "\n";
  await writeFile(boundPath, submitted);
  return { artifactsDir, boundPath, submitted, stagedPath: join(submissionStagingDir(artifactsDir), `${encodeURIComponent(lane)}.json`) };
}

function run(root: string, artifactsDir: string) {
  return runDeterministicForNextStep({
    root, artifactsDir, selfCliPath: "audit-code", timeoutMs: 30_000,
    narrativeEnabled: false, graphLlmEdgeReasoning: false,
    analyzers: { typescript: "skip", python: "skip", css: "skip", html: "skip", sql: "skip" },
  });
}

test.each([false, true])("a resumed fold cannot commit after stale takeover (dispatch throws: %s)", async (fail) => {
  await withTempDir("fold-ownership-", async (root) => {
    const { artifactsDir, boundPath, submitted, stagedPath } = await fixture(root);
    const reached = gate<ArtifactBundle>();
    const resume = gate<void>();
    pause.fail = fail;
    pause.drained = async (bundle) => { reached.resolve(bundle); await resume.promise; };
    const oldFold = run(root, artifactsDir).then((value) => ({ value }), (error: unknown) => ({ error }));
    const bundle = await reached.promise;
    expect(await readFile(stagedPath, "utf8")).toBe(submitted);

    const lockPath = artifactTreeLockPath(artifactsDir);
    const past = new Date(Date.now() - STALE_LOCK_MS * 2);
    await utimes(lockPath, past, past);
    const successorEntered = gate<void>();
    const releaseSuccessor = gate<void>();
    const successor = withArtifactTreeHold(artifactsDir, undefined, async () => {
      // Use the real commit consumer. The report is deliberately absent from the
      // old carried bundle, so a stale prune would destroy it as well as rewrite
      // the state and delete the staged submission.
      await commitFold(artifactsDir, {
        ...bundle, audit_report: "successor authority\n",
        audit_state: { ...bundle.audit_state!, last_executor: "successor" },
      }, createFoldTransaction());
      successorEntered.resolve();
      await releaseSuccessor.promise;
    });
    try {
      await successorEntered.promise;
      const token = await readFile(lockPath, "utf8");
      const stateBefore = await readFile(join(artifactsDir, "audit_state.json"), "utf8");
      resume.resolve();
      const outcome = await oldFold;
      expect(await readFile(join(artifactsDir, "audit_state.json"), "utf8")).toBe(stateBefore);
      expect(await readFile(join(artifactsDir, "audit-report.md"), "utf8")).toBe("successor authority\n");
      expect(await readFile(stagedPath, "utf8")).toBe(submitted);
      expect(await readFile(lockPath, "utf8")).toBe(token);
      expect(outcome).toHaveProperty("error.name", "FileLockOwnershipLostError");
      if (fail) expect(outcome).toHaveProperty("error.cause.message", "injected dispatch failure");
    } finally {
      resume.resolve();
      releaseSuccessor.resolve();
      await Promise.all([oldFold, successor]);
    }

    // Lost ownership follows the existing crash recovery protocol: a later
    // holder restores the still-staged submission rather than losing it.
    await withArtifactTreeHold(artifactsDir, undefined, () => recoverStagedSubmissions(artifactsDir));
    expect(await readFile(boundPath, "utf8")).toBe(submitted);
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    pause.drained = undefined;
    pause.fail = false;
    let resumedFrom: ArtifactBundle | undefined;
    pause.beforeDrain = (current) => { resumedFrom = current; };
    await run(root, artifactsDir);
    expect(resumedFrom?.audit_state?.last_executor).toBe("successor");
    expect(resumedFrom?.audit_report).toBe("successor authority\n");
  });
});

test.each([false, true])("an owned fold still commits and cleans staging (dispatch throws: %s)", async (fail) => {
  await withTempDir("fold-owned-", async (root) => {
    const { artifactsDir, stagedPath } = await fixture(root);
    pause.fail = fail;
    const fold = run(root, artifactsDir);
    if (fail) await expect(fold).rejects.toThrow("injected dispatch failure");
    else expect((await fold).kind).toBe("confirm_intent");
    expect(JSON.parse(await readFile(join(artifactsDir, "audit_state.json"), "utf8"))).toHaveProperty("status");
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(artifactTreeLockPath(artifactsDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
