// Tests for N-CE301: partial-completion terminal — audit state + synthesis report

import { test, expect, onTestFinished } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditTask } from "../../src/audit/types.js";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");
const { buildAuditReportModel, renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.js");
const {
  readActiveDispatch,
  persistPausedState,
  recordPartialCompletionTerminal,
} = await import("../../src/audit/cli/dispatch/pausePersist.js");
const { ACTIVE_DISPATCH_FILENAME } = await import("../../src/audit/types/activeDispatch.js");

// ── Minimal bundle helpers ───────────────────────────────────────────────────

function makeAuditTask(
  task: Pick<AuditTask, "task_id" | "unit_id" | "lens">,
): AuditTask {
  return {
    ...task,
    pass_id: "P1",
    file_paths: ["src/a.ts"],
    rationale: "partial-completion terminal fixture",
    status: "pending",
  };
}

function makeMinimalBundle(overrides: ArtifactBundle = {}): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/a.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/a.ts", status: "included" }],
    },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00Z",
      findings: [],
      reviewed: true,
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "all",
      intent_summary: "full audit",
    },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    ...overrides,
  };
}

// ── audit state: partial_completion_terminal unlocks synthesis ───────────────

await test("N-CE301: pending audit tasks keep audit_tasks_completed missing (baseline)", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      makeAuditTask({ task_id: "T1", unit_id: "U1", lens: "security" }),
    ],
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "without terminal, pending tasks → missing").toBe("missing");
});

await test("N-CE301: partial_completion_terminal present → audit_tasks_completed satisfied despite pending tasks", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      makeAuditTask({ task_id: "T1", unit_id: "U1", lens: "security" }),
    ],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "partial_completion_terminal must unlock audit_tasks_completed").toBe("satisfied");
});

await test("N-CE301: livelock_guard terminal also satisfies audit_tasks_completed", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      makeAuditTask({ task_id: "T2", unit_id: "U2", lens: "correctness" }),
      makeAuditTask({ task_id: "T3", unit_id: "U3", lens: "security" }),
    ],
    active_dispatch: {
      run_id: "R2",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "livelock_guard",
        stranded_ids: ["T2", "T3"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state).toBe("satisfied");
});

await test("N-CE301: terminal only covers stranded IDs — non-stranded pending tasks still block", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      makeAuditTask({ task_id: "T1", unit_id: "U1", lens: "security" }),
      makeAuditTask({ task_id: "T2", unit_id: "U2", lens: "correctness" }),
    ],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      // Only T1 is stranded — T2 should still show as missing
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "T2 is still pending and NOT stranded → missing").toBe("missing");
});

// ── synthesis report: stranded_unit_count from partial_completion_terminal ───

await test("N-CE301: stranded_unit_count populated from partial_completion_terminal", () => {
  const model = buildAuditReportModel({
    results: [],
    activeDispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1", "T2"],
      },
    },
  });
  expect(model.summary.stranded_unit_count).toBe(2);
});

await test("N-CE301: stranded_unit_count absent when no partial_completion_terminal", () => {
  const model = buildAuditReportModel({ results: [] });
  expect(model.summary.stranded_unit_count === undefined ||
      model.summary.stranded_unit_count === 0, "stranded_unit_count must be absent or 0 when no terminal").toBeTruthy();
});

await test("N-CE301: renderAuditReportMarkdown includes partial-coverage warning when stranded_unit_count > 0", () => {
  const model = buildAuditReportModel({
    results: [],
    activeDispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1", "T2"],
      },
    },
  });
  const md = renderAuditReportMarkdown(model);
  expect(md).toMatch(/2 unit\(s\) were not audited because the provider pool was exhausted before dispatch could complete \(partial coverage\)/);
});

await test("N-CE301: no partial-coverage warning when no terminal set", () => {
  const model = buildAuditReportModel({ results: [] });
  const md = renderAuditReportMarkdown(model);
  expect(md).not.toMatch(/provider pool was exhausted/);
});

// ── CP-NODE-6: paused_state ⊕ partial_completion_terminal ASYMMETRIC ratchet ──
// (pausePersist.ts persistence layer, not just its obligation-derivation effect
// covered above). The invariant is asymmetric, not a plain XOR: stamping a
// terminal always clears paused_state (direction a), but once stamped a
// terminal must SURVIVE every later same-run_id write, including a later
// persistPausedState (direction b) — erasing it would also reset
// lifecycle.pause_count, forcing the livelock bound to re-earn
// LIVELOCK_PAUSE_LIMIT from scratch.

const RUN_ID_RATCHET = "run-ratchet";

async function seedActiveDispatch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "terminal-ratchet-"));
  await writeFile(
    join(dir, ACTIVE_DISPATCH_FILENAME),
    JSON.stringify({
      run_id: RUN_ID_RATCHET,
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 3,
      task_count: 3,
      status: "active",
    }),
    "utf8",
  );
  return dir;
}

async function readActiveDispatchRaw(dir: string): Promise<{
  paused_state?: unknown;
  partial_completion_terminal?: { reason: string; stranded_ids: string[] };
}> {
  return JSON.parse(await readFile(join(dir, ACTIVE_DISPATCH_FILENAME), "utf8"));
}

await test("CP-NODE-6 ratchet (a): recordPartialCompletionTerminal clears paused_state atomically, even with NO prior clearPausedState call", async () => {
  const dir = await seedActiveDispatch();
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  await persistPausedState(dir, RUN_ID_RATCHET, {
    lifecycle: {
      kind: "waiting_for_provider",
      paused_at: "2026-01-01T00:00:00Z",
      pause_count: 2,
      stranded_node_ids: ["p1"],
    },
    settled_exclusions: ["poolA"],
  });
  expect((await readActiveDispatchRaw(dir)).paused_state, "paused_state recorded").toBeTruthy();

  // A NEW call site, calling recordPartialCompletionTerminal DIRECTLY with no
  // preceding clearPausedState call — the mutual exclusion on the way IN must
  // still be guaranteed by recordPartialCompletionTerminal itself.
  await recordPartialCompletionTerminal(dir, RUN_ID_RATCHET, {
    reason: "livelock_guard",
    stranded_ids: ["T1"],
  });

  const ad = await readActiveDispatchRaw(dir);
  expect(ad.paused_state, "terminal must clear paused_state even without a prior manual clear").toBeUndefined();
  expect(ad.partial_completion_terminal?.reason).toBe("livelock_guard");
});

await test("CP-NODE-6 ratchet (b): a later persistPausedState must NOT clear an already-stamped partial_completion_terminal", async () => {
  const dir = await seedActiveDispatch();
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  // Prior pass already went terminal for a stranded subset of tasks.
  await recordPartialCompletionTerminal(dir, RUN_ID_RATCHET, {
    reason: "livelock_guard",
    stranded_ids: ["T-stranded"],
  });
  let ad = await readActiveDispatchRaw(dir);
  expect(ad.partial_completion_terminal).toBeTruthy();
  expect(ad.paused_state).toBeUndefined();

  // One more same-run_id pass: a pending task OUTSIDE the terminal's
  // stranded_ids drives a fresh first-pause (the "!priorPaused" branch) —
  // routine, per the module doc. This must NOT erase the terminal.
  await persistPausedState(dir, RUN_ID_RATCHET, {
    lifecycle: {
      kind: "waiting_for_provider",
      paused_at: "2026-02-01T00:00:00Z",
      pause_count: 0,
      stranded_node_ids: ["p-other"],
    },
    settled_exclusions: [],
  });

  ad = await readActiveDispatchRaw(dir);
  expect(ad.paused_state, "the new pause is recorded").toBeTruthy();
  expect(
    ad.partial_completion_terminal,
    "the terminal MUST survive a later persistPausedState — a version that drops it must turn this test red",
  ).toBeTruthy();
  expect(ad.partial_completion_terminal?.stranded_ids).toEqual(["T-stranded"]);
  expect(ad.partial_completion_terminal?.reason).toBe("livelock_guard");
});

// ── CP-NODE-6: locked read-modify-write (failure_modes[7]) ───────────────────
// Two concurrent advancers racing persistPausedState on the SAME run_id must
// never interleave read↔write and lose one another's update — the shared
// locked-JSON store (createLockedJsonStore) serializes the critical section.
await test("CP-NODE-6: concurrent persistPausedState calls on the same run_id never lose an update (locked read-modify-write)", async () => {
  const dir = await seedActiveDispatch();
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const N = 6;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      persistPausedState(dir, RUN_ID_RATCHET, {
        lifecycle: {
          kind: "waiting_for_provider",
          paused_at: "2026-01-01T00:00:00Z",
          pause_count: i,
          stranded_node_ids: [`p-${i}`],
        },
        settled_exclusions: [`pool-${i}`],
      }),
    ),
  );

  // Every write is independently valid — the correctness property under test
  // is that the FINAL file is coherent (a legitimate one-of-N result, not a
  // corrupted merge/partial write from an unserialized interleave).
  const ad = await readActiveDispatchRaw(dir);
  expect(ad.paused_state, "a paused_state must be present after N concurrent writes").toBeTruthy();
  const state = ad.paused_state as {
    lifecycle: { pause_count: number; stranded_node_ids: string[] };
    settled_exclusions: string[];
  };
  const i = state.lifecycle.pause_count;
  expect(i >= 0 && i < N, "pause_count must be one of the N written values, not corrupted").toBeTruthy();
  expect(state.lifecycle.stranded_node_ids).toEqual([`p-${i}`]);
  expect(state.settled_exclusions).toEqual([`pool-${i}`]);

  // readActiveDispatch (the public lockless read) sees the same coherent value.
  const viaHelper = await readActiveDispatch(dir, RUN_ID_RATCHET);
  expect(viaHelper?.paused_state).toEqual(state);
});
