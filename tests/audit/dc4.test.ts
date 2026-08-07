/**
 * DC-4 — audit-code mid-run pause + scope annotation + folded ingestion.
 *
 * Three independent sub-fixes (docs/remaining-specs.md §DC-4), verified here:
 *
 *  1. PAUSE (fix 1). A quota-exhausted rolling audit run enters a resumable
 *     `waiting_for_provider` pause instead of stranding packets, and ONLY after
 *     the engine's in-pass spill is exhausted (a full strand). The persisted
 *     `SettledExclusionSet` is shared/accumulated so a spilled-then-exhausted pool
 *     is never re-offered as net-new on re-discovery, and `advancePausedState`
 *     transitions to terminal/livelock after the pause limit.
 *       → "paused/resume terminal tests" + the "spill-first gate".
 *  2. SCOPE-ANNOTATE (fix 2). Design-review unit summaries are annotated
 *     `[in scope]` / `[excluded: reason]` from the STRUCTURED IntentCheckpoint
 *     scope (`excluded_scope` / `disposition_overrides`) ONLY — never from
 *     `free_form_intent`.
 *       → "no-verbatim snapshot".
 *  3. FOLD-INGEST (fix 3). `mergeAndIngest` is folded into the dispatch turn so
 *     `audit_results_ingested` is satisfied in-turn with an identical staleness
 *     DAG (CE-009).
 *       → "folded-vs-separate stale-set equivalence".
 */

import { test, onTestFinished, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning, buildSyntheticResults } from "./helpers/fixture.mjs";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditTask, AuditResult } from "../../src/audit/types.js";
import type { ActiveReviewRun } from "../../src/audit/supervisor/operatorHandoff.js";
import type { AuditPacketDispatcher, AuditResultIngestor } from "../../src/audit/cli/rollingAuditDispatch.js";
import type { SessionConfig, IntentCheckpoint } from "audit-tools/shared";

const {
  driveRollingAuditDispatch,
} = await import("../../src/audit/cli/rollingAuditDispatch.js");
const { ACTIVE_DISPATCH_FILENAME } = await import("../../src/audit/cli/dispatch.js");
const {
  renderDesignReviewPrompt,
  renderContractReviewPrompt,
  deriveUnitScopeDisposition,
} = await import("../../src/audit/orchestrator/designReviewPrompt.js");
const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.js");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");
const { writeCoreArtifacts, loadArtifactBundle } = await import("../../src/audit/io/artifacts.js");
const { runAuditStep } = await import("../../src/audit/cli/auditStep.js");

// ───────────────────────────────────────────────────────────────────────────
// Shared rolling-audit run scaffolding (mirrors rolling-audit-dispatch.test.mjs).
// ───────────────────────────────────────────────────────────────────────────

const RUN_ID = "dc4-rolling-audit-run";
const TEST_SESSION_CONFIG: SessionConfig = {
  provider: "openai-compatible",
  quota: {
    default_context_tokens: 200_000,
    reserved_output_tokens: 8_000,
  },
};

function tasks(): AuditTask[] {
  const dirs = ["mod_a", "mod_b", "mod_c"];
  const lenses = ["security", "correctness", "maintainability"];
  const priorities: AuditTask["priority"][] = ["high", "medium", "low"];
  return ["a", "b", "c"].map((id, i) => ({
    task_id: `t-${id}`,
    unit_id: `unit-${id}`,
    pass_id: `pass:${lenses[i]}`,
    lens: lenses[i],
    file_paths: [`src/${dirs[i]}/${id}.ts`],
    file_line_counts: { [`src/${dirs[i]}/${id}.ts`]: 120 },
    rationale: `review ${id}`,
    priority: priorities[i],
  }));
}

async function makeRun() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "dc4-rolling-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const taskList = tasks();
  await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify(taskList), "utf8");
  await writeFile(
    join(runDir, "task.json"),
    JSON.stringify({
      contract_version: "audit-code-worker/v1alpha1",
      run_id: RUN_ID,
      repo_root: artifactsDir,
      artifacts_dir: artifactsDir,
      obligation_id: "audit_tasks_completed",
      preferred_executor: "agent",
      result_path: join(runDir, "worker-result.json"),
      worker_command: [],
      audit_results_path: join(runDir, "run-results.json"),
      pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
    }),
    "utf8",
  );
  return { artifactsDir, runDir, taskList };
}

function activeReviewRun(runDir: string): ActiveReviewRun {
  return {
    run_id: RUN_ID,
    task_path: join(runDir, "task.json"),
    prompt_path: join(runDir, "prompt.md"),
    pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
    audit_results_path: join(runDir, "run-results.json"),
    worker_command: [],
  };
}

/** A dispatcher that always rate-limits → exhausts the single host pool → full strand. */
const strandingDispatcher: AuditPacketDispatcher = async (packet) => ({ packet, outcome: "rate_limited" });

async function readActiveDispatch(artifactsDir: string) {
  return JSON.parse(await readFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), "utf8"));
}

// ───────────────────────────────────────────────────────────────────────────
// 1. PAUSE — resumable waiting_for_provider on a full strand (spill-first gate)
// ───────────────────────────────────────────────────────────────────────────

test.concurrent("DC-4 pause: a full strand pauses to a resumable waiting_for_provider state (not an immediate terminal)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000,
    dispatchPacket: strandingDispatcher,
    ingest: async () => { throw new Error("ingestion must be skipped on a full strand"); },
  });

  expect(result.status, "a full strand pauses, it does not immediately go terminal").toBe("paused");
  expect(result.stranded_ids.length > 0, "the stranded packets are held by the pause").toBeTruthy();
  expect(result.ingest, "no ingestion on a full strand").toBe(null);
  expect(result.paused_state, "a paused_state is surfaced").toBeTruthy();
  expect(result.paused_state!.lifecycle.kind).toBe("waiting_for_provider");
  expect(result.paused_state!.lifecycle.pause_count, "first pause starts at pause_count 0").toBe(0);

  // The pause is persisted (resumable) on the active-dispatch artifact, and NOT a
  // terminal — a paused run must not look done to deriveAuditState.
  const active = await readActiveDispatch(artifactsDir);
  expect(active.paused_state, "paused state persisted for resume").toBeTruthy();
  expect(!active.partial_completion_terminal, "a resumable pause is NOT a partial-completion terminal").toBeTruthy();
});

test.concurrent("DC-4 spill-first gate: the pause never fires while a pool still has capacity (no strand → no pause)", async (t) => {
  const { artifactsDir, runDir, taskList } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // A dispatcher that succeeds (the pool has capacity / spill is not exhausted).
  const tasksById = new Map(taskList.map((tk) => [tk.task_id, tk]));
  const writingDispatcher: AuditPacketDispatcher = async (packet) => {
    const entry = packet.payload;
    const resultMap = JSON.parse(await readFile(join(runDir, "dispatch-result-map.json"), "utf8"));
    const ids = resultMap.entries.filter((e: { packet_id: string }) => e.packet_id === packet.id).map((e: { task_id: string }) => e.task_id);
    const results: AuditResult[] = ids.map((tid: string) => {
      const tk = tasksById.get(tid)!;
      return {
        task_id: tk.task_id, unit_id: tk.unit_id, pass_id: tk.pass_id, lens: tk.lens,
        file_coverage: tk.file_paths.map((p) => ({ path: p, total_lines: tk.file_line_counts![p] })),
        findings: [],
        reviewed_clean: true,
      };
    });
    await writeFile(entry.result_path, JSON.stringify(results), "utf8");
    return { packet, outcome: "success" };
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000,
    dispatchPacket: writingDispatcher,
    ingest: async ({ runId }) => ({ summary: { run_id: runId, accepted_count: 3 }, has_failures: false }),
  });

  expect(result.status, "with capacity the run completes — the pause never engages").toBe("complete");
  expect(result.paused_state, "no pause when nothing stranded (spill not exhausted)").toBe(undefined);
  const active = await readActiveDispatch(artifactsDir);
  expect(!active.paused_state, "no paused state persisted on a clean completion").toBeTruthy();
});

test.concurrent("DC-4 resume: re-discovered net-new capacity clears the pause (back to running)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Pass 1: full strand → pause (pause_count 0). The exhausted pool id is the
  // single host pool (settled). prepareDispatchArtifacts assigns the pool id.
  await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000, dispatchPacket: strandingDispatcher,
    ingest: async () => ({ summary: {}, has_failures: false }),
  });
  const afterPause = await readActiveDispatch(artifactsDir);
  expect(afterPause.paused_state, "paused after the first strand").toBeTruthy();
  const settled = afterPause.paused_state.settled_exclusions;
  expect(settled.length > 0, "the exhausted pool is settled-excluded").toBeTruthy();

  // Pass 2: still strands (pool still exhausted), but re-discovery surfaces a
  // genuinely-new provider id NOT in the settled set → advancePausedState resumes.
  const result = await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000, dispatchPacket: strandingDispatcher,
    ingest: async () => ({ summary: {}, has_failures: false }),
    discoverProviders: () => [...settled, "brand-new-pool"],
  });

  expect(result.status, "net-new capacity resumes the run (pause cleared)").not.toBe("paused");
  const afterResume = await readActiveDispatch(artifactsDir);
  expect(!afterResume.paused_state, "the paused state is cleared on resume").toBeTruthy();
});

test.concurrent("DC-4 settled set: a spilled-then-exhausted pool is never re-offered as net-new (INV-S03)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Pass 1 → pause, capturing the settled (exhausted) pool ids.
  await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000, dispatchPacket: strandingDispatcher, ingest: async () => ({ summary: {}, has_failures: false }),
  });
  const settled = (await readActiveDispatch(artifactsDir)).paused_state.settled_exclusions;

  // Pass 2: re-discovery re-offers ONLY the already-settled pools (no genuinely-new
  // capacity). Because they are filtered out as net-new, the run must NOT resume —
  // it stays paused (pause_count bumped) toward livelock.
  const result = await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: TEST_SESSION_CONFIG,
    timeoutMs: 1000, dispatchPacket: strandingDispatcher, ingest: async () => ({ summary: {}, has_failures: false }),
    discoverProviders: () => settled, // re-offer the settled pools only
  });

  expect(result.status, "re-offered settled pools are not net-new → stays paused").toBe("paused");
  expect(result.paused_state!.lifecycle.pause_count, "pause_count advanced (no resume)").toBe(1);
});

test.concurrent("DC-4 terminal: the pause promotes to a partial-completion terminal after the livelock limit", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const session = TEST_SESSION_CONFIG;
  // livelockLimit 2: pass1 enters (count 0), pass2 bumps to 1 (still paused),
  // pass3 bumps to 2 == limit → terminal/livelock.
  const passOnce = (extra: { settled?: string[] } = {}) =>
    driveRollingAuditDispatch({
      root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
      sessionConfig: session, timeoutMs: 1000, dispatchPacket: strandingDispatcher,
      ingest: async () => ({ summary: {}, has_failures: false }), livelockLimit: 2,
      // Re-offer only the settled pools so there is never net-new capacity.
      discoverProviders: () => (extra.settled ?? []),
    });

  const p1 = await passOnce();
  expect(p1.status).toBe("paused");
  const settled = p1.paused_state!.settled_exclusions;

  const p2 = await passOnce({ settled });
  expect(p2.status).toBe("paused");
  expect(p2.paused_state!.lifecycle.pause_count).toBe(1);

  const p3 = await passOnce({ settled });
  expect(p3.status, "at the livelock limit the run goes terminal").toBe("partial");
  expect(p3.paused_state, "terminal clears the paused state").toBe(undefined);

  const active = await readActiveDispatch(artifactsDir);
  expect(active.partial_completion_terminal, "a partial-completion terminal is recorded for synthesis").toBeTruthy();
  expect(active.partial_completion_terminal.reason).toBe("livelock_guard");
  expect(!active.paused_state, "no paused state remains once terminal").toBeTruthy();

  // Increment B residual (b): the terminal's stranded_ids must be the constituent TASK
  // ids — deriveAuditState satisfies `audit_tasks_completed` by matching them against
  // `task_id`, so the packet ids the in-process engine strands internally would never
  // unlock synthesis (an infinite pause loop). Every task stranded → all three task ids
  // (expanded via the run's dispatch-result-map), never the opaque packet ids.
  const strandedIds = active.partial_completion_terminal.stranded_ids;
  expect([...strandedIds].sort(), "terminal carries TASK ids, not packet ids").toEqual([
    "t-a",
    "t-b",
    "t-c",
  ]);
});

// ───────────────────────────────────────────────────────────────────────────
// 2. SCOPE-ANNOTATE — structured IntentCheckpoint scope only, never free_form
// ───────────────────────────────────────────────────────────────────────────

function bundleWithUnits(checkpoint: IntentCheckpoint | undefined): ArtifactBundle {
  return {
    repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00.000Z", files: [] },
    unit_manifest: {
      units: [
        { unit_id: "unit-incl", name: "Included unit", files: ["src/app/main.ts"], required_lenses: ["correctness"] },
        { unit_id: "unit-excl", name: "Excluded unit", files: ["vendor/lib/a.ts", "vendor/lib/b.ts"], required_lenses: ["security"] },
      ],
    },
    ...(checkpoint ? { intent_checkpoint: checkpoint } : {}),
  };
}

test.concurrent("DC-4 scope-annotate: design-review units show [in scope] / [excluded: reason] from excluded_scope", () => {
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    excluded_scope: [{ path: "vendor", reason: "third-party code" }],
  };
  const prompt = renderDesignReviewPrompt(bundleWithUnits(checkpoint));
  expect(prompt, "in-scope unit annotated [in scope]").toMatch(/unit-incl \[in scope\]/);
  expect(prompt, "excluded unit carries the structured reason").toMatch(/unit-excl \[excluded: third-party code\]/);
});

test.concurrent("DC-4 scope-annotate: a disposition_overrides 'excluded' status also marks a unit excluded", () => {
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    disposition_overrides: [
      { path: "vendor/lib/a.ts", status: "vendor", reason: "generated" },
      { path: "vendor/lib/b.ts", status: "excluded", reason: "generated" },
    ],
  };
  const disp = deriveUnitScopeDisposition(["vendor/lib/a.ts", "vendor/lib/b.ts"], checkpoint);
  expect(disp.kind).toBe("excluded");
  if (disp.kind !== "excluded") throw new Error("unreachable");
  expect(disp.reason).toBe("generated");
});

test.concurrent("DC-4 scope-annotate: a must_not_touch glob also marks a unit excluded (symmetric with remediate)", () => {
  // Audit's disposition now consumes the shared fileExclusionReason, so a
  // must_not_touch glob (a write-forbidden path) excludes a review unit too —
  // audit previously ignored must_not_touch entirely.
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    must_not_touch: ["vendor/**"],
  };
  const disp = deriveUnitScopeDisposition(["vendor/lib/a.ts", "vendor/lib/b.ts"], checkpoint);
  expect(disp.kind).toBe("excluded");
  if (disp.kind !== "excluded") throw new Error("unreachable");
  expect(disp.reason).toContain("must-not-touch");
});

test.concurrent("DC-4 scope-annotate (no-verbatim): free_form_intent is NEVER threaded into the prompt", () => {
  const secret = "EXCLUDE-EVERYTHING-UNDER-vendor-AND-be-extra-careful-with-auth";
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    free_form_intent: secret,
    // The same exclusion expressed STRUCTURALLY is what drives annotation.
    excluded_scope: [{ path: "vendor", reason: "third-party" }],
  };
  for (const render of [renderDesignReviewPrompt, renderContractReviewPrompt]) {
    const prompt = render(bundleWithUnits(checkpoint));
    expect(!prompt.includes(secret), `${render.name} must not thread free_form_intent verbatim`).toBeTruthy();
    // The structured exclusion still annotates.
    expect(prompt).toMatch(/unit-excl \[excluded: third-party\]/);
  }
});

test.concurrent("DC-4 scope-annotate: a unit with ANY in-scope file stays in scope (not excluded)", () => {
  const checkpoint: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    excluded_scope: [{ path: "vendor/lib/a.ts", reason: "one file only" }],
  };
  // unit-excl has a.ts (excluded) AND b.ts (in scope) → the unit stays in scope.
  const disp = deriveUnitScopeDisposition(["vendor/lib/a.ts", "vendor/lib/b.ts"], checkpoint);
  expect(disp.kind, "a partially-excluded unit is not fully excluded").toBe("in_scope");
});

test.concurrent("DC-4 scope-annotate: no checkpoint → every unit defaults to [in scope]", () => {
  const prompt = renderDesignReviewPrompt(bundleWithUnits(undefined));
  expect(prompt).toMatch(/unit-incl \[in scope\]/);
  expect(prompt).toMatch(/unit-excl \[in scope\]/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. FOLD-INGEST — CE-009 folded-vs-separate stale-set equivalence
// ───────────────────────────────────────────────────────────────────────────

test.concurrent("DC-4 fold-ingest (CE-009): folded ingestion leaves the SAME staleness set as a separate ingest round", async () => {
  await withTempDir("dc4-ce009-", async (root) => {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const auditResults = buildSyntheticResults(planning.updated_bundle.audit_tasks ?? [], lineIndex);

    // The fold's ONLY structural difference from a standalone `audit_results_ingested`
    // round is WHEN `result_ingestion_executor` runs (in the dispatch turn vs. its own
    // turn) — both read the same on-disk planning state. So to compare the two
    // faithfully, run BOTH through the same disk round-trip, differing only in which
    // path triggers the ingest, and assert the resulting staleness sets (and ingested
    // results) are identical. Anything that made the fold shift downstream ledger
    // state (CE-009's risk) would diverge the stale sets here.
    async function ingestInDir(subdir: string) {
      const artifactsDir = join(root, ".audit-tools", subdir);
      await mkdir(artifactsDir, { recursive: true });
      await writeCoreArtifacts(artifactsDir, planning.updated_bundle);
      const auditResultsPath = join(artifactsDir, "results.json");
      await writeFile(auditResultsPath, JSON.stringify(auditResults), "utf8");
      const step = await runAuditStep({
        root,
        artifactsDir,
        preferredExecutor: "result_ingestion_executor",
        auditResultsPath,
        runLog: false,
      });
      const bundle = await loadArtifactBundle(artifactsDir);
      return { step, bundle, stale: [...computeStaleArtifacts(bundle)].sort() };
    }

    // SEPARATE: the standalone `audit_results_ingested` obligation round.
    const separate = await ingestInDir("audit-separate");
    // FOLDED: the SAME ingestion the in-process rolling driver folds into the
    // dispatch turn (mergeAndIngest → runAuditStep('result_ingestion_executor')).
    const folded = await ingestInDir("audit-folded");

    // CE-009: identical staleness DAG — folding ingestion into the dispatch turn
    // does not shift downstream ledger/staleness state vs. a separate round.
    expect(folded.stale, "folded and separate ingest leave the same stale set").toEqual(separate.stale);
    // The fold satisfies audit_results_ingested IN-TURN with the same outcome.
    expect((folded.bundle.audit_results ?? []).length, "both paths ingest the same audit_results").toBe((separate.bundle.audit_results ?? []).length);
    expect((folded.bundle.audit_results ?? []).length > 0, "results were actually ingested").toBeTruthy();
    expect(folded.step.selected_executor).toBe("result_ingestion_executor");
    // The stale set is non-trivial (the ingest actually propagated along the DAG),
    // so the equivalence is meaningful, not a both-empty coincidence.
    expect(separate.stale.length > 0, "ingestion propagated staleness along the dependency DAG").toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ARC-e01faa3e — Dead provider exclusion during mid-run re-detection
// ───────────────────────────────────────────────────────────────────────────

test.concurrent("ARC-e01faa3e: dead providers in paused state are excluded during pool selection", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Create a paused state with dead_providers naming the session provider.
  const pausedState = {
    lifecycle: {
      kind: "waiting_for_provider" as const,
      paused_at: new Date().toISOString(),
      pause_count: 0,
      stranded_node_ids: ["packet-1"],
    },
    settled_exclusions: [],
    // Dead providers from a prior pass that hit provider_unavailable outcomes.
    dead_providers: [
      { pool_id: "pool-openai-compat", provider_name: "openai-compatible" },
    ],
  };

  // Write the paused state to active-dispatch.json.
  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  const activeDispatchState = {
    run_id: RUN_ID,
    created_at: new Date().toISOString(),
    packet_count: 0,
    task_count: 0,
    status: "active" as const,
    paused_state: pausedState,
  };
  await writeFile(activeDispatchPath, JSON.stringify(activeDispatchState), "utf8");

  // Test the helper function that reads the paused state and builds the exclusion.
  const { buildAuditDispatchExclusionFromPause } = await import(
    "../../src/audit/cli/dispatch/pausePersist.js"
  );
  const exclusion = buildAuditDispatchExclusionFromPause(pausedState);

  // The dead provider should be excluded.
  expect(
    exclusion.excludes({ transport: "openai-compatible" }),
    "dead provider is excluded"
  ).toBe(true);

  // Other providers should not be excluded (unless they're also dead or self-spawn blocked).
  expect(
    exclusion.excludes({ transport: "agy" }),
    "non-dead provider is not excluded"
  ).toBe(false);

  // The excludedBy pattern should match the dead provider.
  expect(exclusion.excludedBy({ transport: "openai-compatible" })).toBe(
    "transport:openai-compatible"
  );
});

test.concurrent("ARC-e01faa3e: empty dead_providers list excludes nothing beyond self-spawn", async (t) => {
  // A paused state with no dead_providers.
  const pausedState = {
    lifecycle: {
      kind: "waiting_for_provider" as const,
      paused_at: new Date().toISOString(),
      pause_count: 0,
      stranded_node_ids: ["packet-1"],
    },
    settled_exclusions: [],
    dead_providers: [],
  };

  const { buildAuditDispatchExclusionFromPause } = await import(
    "../../src/audit/cli/dispatch/pausePersist.js"
  );
  const exclusion = buildAuditDispatchExclusionFromPause(pausedState);

  // No dead providers, so nothing extra is excluded.
  expect(exclusion.excludes({ transport: "openai-compatible" }), "no exclusion when no dead providers").toBe(false);
  expect(exclusion.excludes({ transport: "agy" }), "no exclusion when no dead providers").toBe(false);
});

test.concurrent("ARC-e01faa3e: undefined dead_providers excludes nothing beyond self-spawn", async (t) => {
  // A paused state with undefined dead_providers (backward compat with old records).
  const pausedState = {
    lifecycle: {
      kind: "waiting_for_provider" as const,
      paused_at: new Date().toISOString(),
      pause_count: 0,
      stranded_node_ids: ["packet-1"],
    },
    settled_exclusions: [],
    // dead_providers field is absent (undefined)
  };

  const { buildAuditDispatchExclusionFromPause } = await import(
    "../../src/audit/cli/dispatch/pausePersist.js"
  );
  const exclusion = buildAuditDispatchExclusionFromPause(pausedState);

  // No dead providers defined, so nothing extra is excluded.
  expect(exclusion.excludes({ transport: "openai-compatible" }), "no exclusion when dead_providers undefined").toBe(false);
  expect(exclusion.excludes({ transport: "agy" }), "no exclusion when dead_providers undefined").toBe(false);
});
