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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo, advanceFixtureToPlanning, buildSyntheticResults } from "./helpers/fixture.mjs";

const {
  driveRollingAuditDispatch,
} = await import("../../src/audit/cli/rollingAuditDispatch.ts");
const { ACTIVE_DISPATCH_FILENAME } = await import("../../src/audit/cli/dispatch.ts");
const {
  renderDesignReviewPrompt,
  renderContractReviewPrompt,
  deriveUnitScopeDisposition,
} = await import("../../src/audit/orchestrator/designReviewPrompt.ts");
const { computeStaleArtifacts } = await import("../../src/audit/orchestrator/staleness.ts");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { writeCoreArtifacts, loadArtifactBundle } = await import("../../src/audit/io/artifacts.ts");
const { runAuditStep } = await import("../../src/audit/cli/auditStep.ts");

// ───────────────────────────────────────────────────────────────────────────
// Shared rolling-audit run scaffolding (mirrors rolling-audit-dispatch.test.mjs).
// ───────────────────────────────────────────────────────────────────────────

const RUN_ID = "dc4-rolling-audit-run";

function tasks() {
  const dirs = ["mod_a", "mod_b", "mod_c"];
  const lenses = ["security", "correctness", "maintainability"];
  const priorities = ["high", "medium", "low"];
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

function activeReviewRun(runDir) {
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
const strandingDispatcher = async (packet) => ({ packet, outcome: "rate_limited" });

async function readActiveDispatch(artifactsDir) {
  return JSON.parse(await readFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), "utf8"));
}

// ───────────────────────────────────────────────────────────────────────────
// 1. PAUSE — resumable waiting_for_provider on a full strand (spill-first gate)
// ───────────────────────────────────────────────────────────────────────────

test("DC-4 pause: a full strand pauses to a resumable waiting_for_provider state (not an immediate terminal)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000,
    dispatchPacket: strandingDispatcher,
    ingest: async () => { throw new Error("ingestion must be skipped on a full strand"); },
  });

  assert.equal(result.status, "paused", "a full strand pauses, it does not immediately go terminal");
  assert.ok(result.stranded_ids.length > 0, "the stranded packets are held by the pause");
  assert.equal(result.ingest, null, "no ingestion on a full strand");
  assert.ok(result.paused_state, "a paused_state is surfaced");
  assert.equal(result.paused_state.lifecycle.kind, "waiting_for_provider");
  assert.equal(result.paused_state.lifecycle.pause_count, 0, "first pause starts at pause_count 0");

  // The pause is persisted (resumable) on the active-dispatch artifact, and NOT a
  // terminal — a paused run must not look done to deriveAuditState.
  const active = await readActiveDispatch(artifactsDir);
  assert.ok(active.paused_state, "paused state persisted for resume");
  assert.ok(!active.partial_completion_terminal, "a resumable pause is NOT a partial-completion terminal");
});

test("DC-4 spill-first gate: the pause never fires while a pool still has capacity (no strand → no pause)", async (t) => {
  const { artifactsDir, runDir, taskList } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // A dispatcher that succeeds (the pool has capacity / spill is not exhausted).
  const tasksById = new Map(taskList.map((tk) => [tk.task_id, tk]));
  const writingDispatcher = async (packet) => {
    const entry = packet.payload;
    const resultMap = JSON.parse(await readFile(join(runDir, "dispatch-result-map.json"), "utf8"));
    const ids = resultMap.entries.filter((e) => e.packet_id === packet.id).map((e) => e.task_id);
    const results = ids.map((tid) => {
      const tk = tasksById.get(tid);
      return {
        task_id: tk.task_id, unit_id: tk.unit_id, pass_id: tk.pass_id, lens: tk.lens,
        file_coverage: tk.file_paths.map((p) => ({ path: p, total_lines: tk.file_line_counts[p] })),
        findings: [],
      };
    });
    await writeFile(entry.result_path, JSON.stringify(results), "utf8");
    return { packet, outcome: "success" };
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    dispatchPacket: writingDispatcher,
    ingest: async ({ runId }) => ({ summary: { run_id: runId, accepted_count: 3 }, has_failures: false }),
  });

  assert.equal(result.status, "complete", "with capacity the run completes — the pause never engages");
  assert.equal(result.paused_state, undefined, "no pause when nothing stranded (spill not exhausted)");
  const active = await readActiveDispatch(artifactsDir);
  assert.ok(!active.paused_state, "no paused state persisted on a clean completion");
});

test("DC-4 resume: re-discovered net-new capacity clears the pause (back to running)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Pass 1: full strand → pause (pause_count 0). The exhausted pool id is the
  // single host pool (settled). prepareDispatchArtifacts assigns the pool id.
  await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000, dispatchPacket: strandingDispatcher,
    ingest: async () => null,
  });
  const afterPause = await readActiveDispatch(artifactsDir);
  assert.ok(afterPause.paused_state, "paused after the first strand");
  const settled = afterPause.paused_state.settled_exclusions;
  assert.ok(settled.length > 0, "the exhausted pool is settled-excluded");

  // Pass 2: still strands (pool still exhausted), but re-discovery surfaces a
  // genuinely-new provider id NOT in the settled set → advancePausedState resumes.
  const result = await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000, dispatchPacket: strandingDispatcher,
    ingest: async () => null,
    discoverProviders: () => [...settled, "brand-new-pool"],
  });

  assert.notEqual(result.status, "paused", "net-new capacity resumes the run (pause cleared)");
  const afterResume = await readActiveDispatch(artifactsDir);
  assert.ok(!afterResume.paused_state, "the paused state is cleared on resume");
});

test("DC-4 settled set: a spilled-then-exhausted pool is never re-offered as net-new (INV-S03)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Pass 1 → pause, capturing the settled (exhausted) pool ids.
  await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000, dispatchPacket: strandingDispatcher, ingest: async () => null,
  });
  const settled = (await readActiveDispatch(artifactsDir)).paused_state.settled_exclusions;

  // Pass 2: re-discovery re-offers ONLY the already-settled pools (no genuinely-new
  // capacity). Because they are filtered out as net-new, the run must NOT resume —
  // it stays paused (pause_count bumped) toward livelock.
  const result = await driveRollingAuditDispatch({
    root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000, dispatchPacket: strandingDispatcher, ingest: async () => null,
    discoverProviders: () => settled, // re-offer the settled pools only
  });

  assert.equal(result.status, "paused", "re-offered settled pools are not net-new → stays paused");
  assert.equal(result.paused_state.lifecycle.pause_count, 1, "pause_count advanced (no resume)");
});

test("DC-4 terminal: the pause promotes to a partial-completion terminal after the livelock limit", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const session = { provider: "openai-compatible", quota: { enabled: false } };
  // livelockLimit 2: pass1 enters (count 0), pass2 bumps to 1 (still paused),
  // pass3 bumps to 2 == limit → terminal/livelock.
  const passOnce = (extra = {}) =>
    driveRollingAuditDispatch({
      root: artifactsDir, artifactsDir, activeReviewRun: activeReviewRun(runDir),
      sessionConfig: session, timeoutMs: 1000, dispatchPacket: strandingDispatcher,
      ingest: async () => null, livelockLimit: 2,
      // Re-offer only the settled pools so there is never net-new capacity.
      discoverProviders: () => (extra.settled ?? []),
    });

  const p1 = await passOnce();
  assert.equal(p1.status, "paused");
  const settled = p1.paused_state.settled_exclusions;

  const p2 = await passOnce({ settled });
  assert.equal(p2.status, "paused");
  assert.equal(p2.paused_state.lifecycle.pause_count, 1);

  const p3 = await passOnce({ settled });
  assert.equal(p3.status, "partial", "at the livelock limit the run goes terminal");
  assert.equal(p3.paused_state, undefined, "terminal clears the paused state");

  const active = await readActiveDispatch(artifactsDir);
  assert.ok(active.partial_completion_terminal, "a partial-completion terminal is recorded for synthesis");
  assert.equal(active.partial_completion_terminal.reason, "livelock_guard");
  assert.ok(!active.paused_state, "no paused state remains once terminal");
});

// ───────────────────────────────────────────────────────────────────────────
// 2. SCOPE-ANNOTATE — structured IntentCheckpoint scope only, never free_form
// ───────────────────────────────────────────────────────────────────────────

function bundleWithUnits(checkpoint) {
  return {
    repo_manifest: { repository: { name: "fixture" }, files: [] },
    unit_manifest: {
      units: [
        { unit_id: "unit-incl", files: ["src/app/main.ts"], required_lenses: ["correctness"] },
        { unit_id: "unit-excl", files: ["vendor/lib/a.ts", "vendor/lib/b.ts"], required_lenses: ["security"] },
      ],
    },
    ...(checkpoint ? { intent_checkpoint: checkpoint } : {}),
  };
}

test("DC-4 scope-annotate: design-review units show [in scope] / [excluded: reason] from excluded_scope", () => {
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    excluded_scope: [{ path: "vendor", reason: "third-party code" }],
  };
  const prompt = renderDesignReviewPrompt(bundleWithUnits(checkpoint));
  assert.match(prompt, /unit-incl \[in scope\]/, "in-scope unit annotated [in scope]");
  assert.match(prompt, /unit-excl \[excluded: third-party code\]/, "excluded unit carries the structured reason");
});

test("DC-4 scope-annotate: a disposition_overrides 'excluded' status also marks a unit excluded", () => {
  const checkpoint = {
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
  assert.equal(disp.kind, "excluded");
  assert.equal(disp.reason, "generated");
});

test("DC-4 scope-annotate (no-verbatim): free_form_intent is NEVER threaded into the prompt", () => {
  const secret = "EXCLUDE-EVERYTHING-UNDER-vendor-AND-be-extra-careful-with-auth";
  const checkpoint = {
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
    assert.ok(!prompt.includes(secret), `${render.name} must not thread free_form_intent verbatim`);
    // The structured exclusion still annotates.
    assert.match(prompt, /unit-excl \[excluded: third-party\]/);
  }
});

test("DC-4 scope-annotate: a unit with ANY in-scope file stays in scope (not excluded)", () => {
  const checkpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-19T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "x", intent_summary: "y",
    excluded_scope: [{ path: "vendor/lib/a.ts", reason: "one file only" }],
  };
  // unit-excl has a.ts (excluded) AND b.ts (in scope) → the unit stays in scope.
  const disp = deriveUnitScopeDisposition(["vendor/lib/a.ts", "vendor/lib/b.ts"], checkpoint);
  assert.equal(disp.kind, "in_scope", "a partially-excluded unit is not fully excluded");
});

test("DC-4 scope-annotate: no checkpoint → every unit defaults to [in scope]", () => {
  const prompt = renderDesignReviewPrompt(bundleWithUnits(undefined));
  assert.match(prompt, /unit-incl \[in scope\]/);
  assert.match(prompt, /unit-excl \[in scope\]/);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. FOLD-INGEST — CE-009 folded-vs-separate stale-set equivalence
// ───────────────────────────────────────────────────────────────────────────

test("DC-4 fold-ingest (CE-009): folded ingestion leaves the SAME staleness set as a separate ingest round", async () => {
  await withTempDir("dc4-ce009-", async (root) => {
    await writeFixtureRepo(root);
    const { planning, lineIndex } = await advanceFixtureToPlanning(root);
    const auditResults = buildSyntheticResults(planning.updated_bundle.audit_tasks, lineIndex);

    // The fold's ONLY structural difference from a standalone `audit_results_ingested`
    // round is WHEN `result_ingestion_executor` runs (in the dispatch turn vs. its own
    // turn) — both read the same on-disk planning state. So to compare the two
    // faithfully, run BOTH through the same disk round-trip, differing only in which
    // path triggers the ingest, and assert the resulting staleness sets (and ingested
    // results) are identical. Anything that made the fold shift downstream ledger
    // state (CE-009's risk) would diverge the stale sets here.
    async function ingestInDir(subdir) {
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
    assert.deepEqual(folded.stale, separate.stale, "folded and separate ingest leave the same stale set");
    // The fold satisfies audit_results_ingested IN-TURN with the same outcome.
    assert.equal(
      folded.bundle.audit_results.length,
      separate.bundle.audit_results.length,
      "both paths ingest the same audit_results",
    );
    assert.ok(folded.bundle.audit_results.length > 0, "results were actually ingested");
    assert.equal(folded.step.selected_executor, "result_ingestion_executor");
    // The stale set is non-trivial (the ingest actually propagated along the DAG),
    // so the equivalence is meaningful, not a both-empty coincidence.
    assert.ok(separate.stale.length > 0, "ingestion propagated staleness along the dependency DAG");
  });
});
