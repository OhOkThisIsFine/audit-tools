import { test, expect } from "vitest";

// O3 — drift re-dispatch + supersession + convergence, end to end across the
// ingestion executor, the ledger keys, and the staleness gate.
const {
  appendResultsToLedger,
  selectCurrentResults,
  maxRedispatchAttempt,
  emitSourceFor,
} = await import("../../src/audit/orchestrator/ledger.ts");
const {
  refreshResultBaselines,
  rekeyDriftedResults,
  computeStaleResultTaskIds,
  taskContentSignatureForTask,
} = await import("../../src/audit/orchestrator/resultBaseline.ts");

function task(over = {}) {
  return {
    task_id: "u1:security",
    unit_id: "u1",
    pass_id: "p1",
    lens: "security",
    file_paths: ["a.ts"],
    file_line_counts: { "a.ts": 100 },
    rationale: "audit a.ts",
    ...over,
  };
}

function baseResult(findings, over = {}) {
  return {
    task_id: "u1:security",
    unit_id: "u1",
    pass_id: "p1",
    lens: "security",
    file_coverage: [],
    findings,
    ...over,
  };
}

const tasksByTaskId = (t) => new Map([[t.task_id, t]]);

test("first ingest establishes baseline; unchanged content never drifts", () => {
  const t = task();
  const tasks = tasksByTaskId(t);
  const r = baseResult([{ id: "F1" }]);

  // No baseline yet → rekey is a pass-through (genuine base result).
  const rekeyed = rekeyDriftedResults([r], tasks, {}, []);
  expect(rekeyed[0].emit_source, "no drift on first ingest").toBe(undefined);
  const ledger = appendResultsToLedger([], rekeyed);
  expect(ledger.length).toBe(1);

  // Record the baseline, then re-derive with UNCHANGED content → not stale.
  const baselines = refreshResultBaselines(undefined, rekeyed, tasks);
  const stale = computeStaleResultTaskIds(
    selectCurrentResults(ledger),
    [t],
    baselines,
  );
  expect(stale.size, "unchanged content is not stale").toBe(0);
});

test("content drift → re-dispatch appends fresh findings, supersedes, converges", () => {
  const t = task();
  let tasks = tasksByTaskId(t);

  // Round 1: base ingest of finding F_old.
  const r1 = baseResult([{ id: "F_old" }]);
  const ingest1 = rekeyDriftedResults([r1], tasks, {}, []);
  let ledger = appendResultsToLedger([], ingest1);
  let baselines = refreshResultBaselines(undefined, ingest1, tasks);
  expect(selectCurrentResults(ledger).flatMap((r) => r.findings.map((f) => f.id))).toEqual(["F_old"]);

  // Content of the task changes (the file grew). The CURRENT base result now
  // drifts from its baseline → the gate marks the task for re-dispatch.
  const tEdited = task({ file_line_counts: { "a.ts": 250 } });
  tasks = tasksByTaskId(tEdited);
  expect(taskContentSignatureForTask(t), "edit moves the live signature").not.toBe(taskContentSignatureForTask(tEdited));
  const staleBefore = computeStaleResultTaskIds(
    selectCurrentResults(ledger),
    [tEdited],
    baselines,
  );
  expect(staleBefore.has("u1:security"), "drift fires staleness → re-dispatch").toBeTruthy();

  // Round 2: the re-audit returns a fresh base-shaped result (F_new, F_old dropped).
  // Ingestion re-keys it as redispatch attempt 1 → DISTINCT idempotency_key →
  // the append-only ledger ACCEPTS it (no idempotent no-op).
  const r2 = baseResult([{ id: "F_new" }]);
  const ingest2 = rekeyDriftedResults([r2], tasks, baselines, ledger);
  expect(ingest2[0].emit_source).toBe("redispatch");
  expect(ingest2[0].attempt).toBe(1);
  const ledgerBefore = ledger.length;
  ledger = appendResultsToLedger(ledger, ingest2);
  expect(ledger.length, "fresh redispatch record appended").toBe(ledgerBefore + 1);
  baselines = refreshResultBaselines(baselines, ingest2, tasks);

  // Supersession: only the redispatch (F_new) is current; the stale F_old base
  // record — including the DROPPED finding — never surfaces.
  const current = selectCurrentResults(ledger);
  expect(current.length, "base lineage collapses to the current record").toBe(1);
  expect(current.flatMap((r) => r.findings.map((f) => f.id)), "superseded F_old gone; F_new current").toEqual(["F_new"]);

  // Convergence: with the baseline refreshed to the edited content, the gate is
  // quiet — no infinite re-dispatch loop.
  const staleAfter = computeStaleResultTaskIds(current, [tEdited], baselines);
  expect(staleAfter.size, "re-dispatch converges (no re-loop)").toBe(0);

  // A second drift bumps to attempt 2 (monotonic, distinct key).
  expect(maxRedispatchAttempt(ledger, "u1:security")).toBe(1);
});

test("supersession keys on task_id, never identity_key — distinct tasks never collapse", () => {
  // Two records with DISTINCT task_ids must both be current, even if they were to
  // share an identity coordinate. Supersession groups by task_id, so distinct
  // tasks are never conflated. (Exercises selectCurrentResults directly — the
  // append-time idempotency collision for same-identity siblings is a SEPARATE,
  // pre-existing ledger limitation tracked in docs/backlog.md.)
  const a = baseResult([{ id: "A" }], { task_id: "u1:security:part-1" });
  const b = baseResult([{ id: "B" }], { task_id: "u2:security:part-2", unit_id: "u2" });
  const current = selectCurrentResults([a, b]);
  expect(current.length, "distinct tasks both retained").toBe(2);
  expect(current.flatMap((r) => r.findings.map((f) => f.id)).sort()).toEqual(["A", "B"]);

  // Same task_id, base + redispatch → collapses to the higher attempt.
  const base = baseResult([{ id: "OLD" }], { task_id: "u1:security" });
  const redis = baseResult([{ id: "NEW" }], {
    task_id: "u1:security",
    emit_source: "redispatch",
    attempt: 1,
  });
  const collapsed = selectCurrentResults([base, redis]);
  expect(collapsed.length).toBe(1);
  expect(collapsed[0].findings.map((f) => f.id)).toEqual(["NEW"]);
});

test("emitSourceFor reads a persisted emit_source before the task_id prefix", () => {
  expect(emitSourceFor(baseResult([]))).toBe("base");
  expect(emitSourceFor(baseResult([], { emit_source: "redispatch", attempt: 2 }))).toBe("redispatch");
  expect(emitSourceFor(baseResult([], { task_id: "deepening:x" }))).toBe("deepening");
});
