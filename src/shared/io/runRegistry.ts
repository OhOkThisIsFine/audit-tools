import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  readJsonFile,
  writeJsonFile,
} from "./json.js";
import {
  isRunIdSafe,
  registryLockPath,
  registryPath,
} from "./auditToolsPaths.js";
import { withFileLock } from "../quota/fileLock.js";

/**
 * Cross-run registry for multi-IDE concurrent runs
 * (`spec/multi-ide-concurrent-runs-design.md`). Tracks WHAT each run is working
 * on — not who is running it (no host label) and not when it last ran (no TTL /
 * heartbeat liveness; staleness vs. the current tree is a dependency-DAG
 * question answered at resume, never a clock question). A run entry persists
 * until explicitly retired; runs and their worktrees/results are never
 * auto-pruned.
 *
 * The registry is the single source for "what runs exist and what each covers";
 * run resolution (`resolveRun`) is a deterministic function of (supplied
 * run-id, registry contents) so no host reasoning is involved.
 */

export type RunOrchestrator = "audit" | "remediate";
export type RunStatus = "active" | "complete";

export interface RunRecord {
  readonly orchestrator: RunOrchestrator;
  readonly started_at: string;
  status: RunStatus;
  /**
   * What this run claims: an audit scope/lens digest, or a remediate plan source
   * + finding ids. This is what the disambiguation manifest shows so a new run
   * can pick uncovered work.
   */
  coverage: string;
}

export interface RunRegistry {
  runs: Record<string, RunRecord>;
}

const EMPTY_REGISTRY: RunRegistry = { runs: {} };

async function readRegistry(baseArtifactsDir: string): Promise<RunRegistry> {
  try {
    const parsed = await readJsonFile<RunRegistry>(
      registryPath(baseArtifactsDir),
    );
    // Tolerate a malformed / partial file by degrading to empty rather than
    // throwing — a fresh run should never be blocked by a corrupt registry.
    if (!parsed || typeof parsed !== "object" || typeof parsed.runs !== "object") {
      return { runs: {} };
    }
    return { runs: { ...parsed.runs } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { runs: {} };
    }
    throw error;
  }
}

async function writeRegistry(
  baseArtifactsDir: string,
  registry: RunRegistry,
): Promise<void> {
  const path = registryPath(baseArtifactsDir);
  await mkdir(dirname(path), { recursive: true });
  await writeJsonFile(path, registry);
}

/**
 * Apply a read-modify-write to the registry under the cross-run `registry.lock`.
 * The critical section is tiny — never wrap an advance in this.
 */
async function mutateRegistry<T>(
  baseArtifactsDir: string,
  fn: (registry: RunRegistry) => { registry: RunRegistry; result: T },
): Promise<T> {
  await mkdir(baseArtifactsDir, { recursive: true });
  return withFileLock(registryLockPath(baseArtifactsDir), async () => {
    const current = await readRegistry(baseArtifactsDir);
    const { registry, result } = fn(current);
    await writeRegistry(baseArtifactsDir, registry);
    return result;
  });
}

/** Register a freshly-minted run (status `active`). Overwrites an existing id (should not collide). */
export async function registerRun(
  baseArtifactsDir: string,
  runId: string,
  record: Omit<RunRecord, "status"> & { status?: RunStatus },
): Promise<void> {
  if (!isRunIdSafe(runId)) {
    throw new Error(`Unsafe runId ${JSON.stringify(runId)} — must match [A-Za-z0-9_-]+`);
  }
  await mutateRegistry(baseArtifactsDir, (registry) => {
    registry.runs[runId] = {
      orchestrator: record.orchestrator,
      started_at: record.started_at,
      status: record.status ?? "active",
      coverage: record.coverage,
    };
    return { registry, result: undefined };
  });
}

/** Patch an existing run's mutable fields (coverage / status). No-op if the run is unknown. */
export async function updateRun(
  baseArtifactsDir: string,
  runId: string,
  patch: Partial<Pick<RunRecord, "coverage" | "status">>,
): Promise<void> {
  await mutateRegistry(baseArtifactsDir, (registry) => {
    const existing = registry.runs[runId];
    if (existing) {
      if (patch.coverage !== undefined) existing.coverage = patch.coverage;
      if (patch.status !== undefined) existing.status = patch.status;
    }
    return { registry, result: undefined };
  });
}

/** Remove a run entry from the registry (the only removal path — never auto-pruned). */
export async function retireRun(
  baseArtifactsDir: string,
  runId: string,
): Promise<void> {
  await mutateRegistry(baseArtifactsDir, (registry) => {
    delete registry.runs[runId];
    return { registry, result: undefined };
  });
}

/** Read-only snapshot of the registry. */
export async function loadRegistry(
  baseArtifactsDir: string,
): Promise<RunRegistry> {
  return readRegistry(baseArtifactsDir);
}

export type RunResolution =
  | { kind: "explicit"; runId: string }
  | { kind: "explicit_unknown"; runId: string }
  | { kind: "new" }
  | { kind: "resume"; runId: string }
  | { kind: "ambiguous"; candidates: Array<{ runId: string } & RunRecord> };

/**
 * Deterministic run resolution — the conversation-first truth table
 * (`spec/multi-ide-concurrent-runs-design.md` §Run resolution). Pure function of
 * (supplied run-id, registry, orchestrator) so it is unit-testable and the host
 * does no reasoning:
 *
 *  1/5. explicit run-id present → `explicit` (or `explicit_unknown` if absent
 *       from the registry, so the caller can error clearly).
 *  1.   no run-id, zero active runs for this orchestrator → `new` (mint).
 *  3.   no run-id, exactly one active run → `resume` it (zero-flag single-IDE
 *       ergonomics preserved).
 *  4.   no run-id, multiple active runs → `ambiguous` (surface the coverage
 *       manifest; contextualize, don't guess).
 *
 * "Active" filters by orchestrator AND `status === "active"` — a completed run
 * never auto-resumes.
 */
export function resolveRun(
  registry: RunRegistry,
  orchestrator: RunOrchestrator,
  suppliedRunId: string | undefined,
): RunResolution {
  if (suppliedRunId !== undefined) {
    return registry.runs[suppliedRunId]
      ? { kind: "explicit", runId: suppliedRunId }
      : { kind: "explicit_unknown", runId: suppliedRunId };
  }

  const active = Object.entries(registry.runs)
    .filter(
      ([, record]) =>
        record.orchestrator === orchestrator && record.status === "active",
    )
    .map(([runId, record]) => ({ runId, ...record }));

  if (active.length === 0) return { kind: "new" };
  if (active.length === 1) return { kind: "resume", runId: active[0].runId };
  return { kind: "ambiguous", candidates: active };
}
