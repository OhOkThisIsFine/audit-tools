import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const {
  measureFrictionCost,
  costSignalsSurface,
  FRICTION_COST_SURFACE_THRESHOLD,
  deriveFrictionObservations,
  prepopulatedObservations,
  decideFrictionTriage,
  buildFrictionTriageBlock,
  FRICTION_CATEGORIES,
} = await import("../../src/shared/friction/triage.ts");
const { captureStepBoundaryFriction, stepBoundaryFrictionCategory } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);

const HERE = dirname(fileURLToPath(import.meta.url));

async function readRecord(dir, runId) {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
}

const evt = (id, category, artifact, extra = {}) => ({
  id,
  note: `note-${id}`,
  frictionCategory: category,
  artifact,
  ...extra,
});

// ── cost signals: round-trips / verbatim-re-authors / tokens ───────────────────

test("measureFrictionCost: round_trips is the event count; a single event has no re-authors", () => {
  const cost = measureFrictionCost([evt("a", "inefficient_feeding", "x")]);
  expect(cost.round_trips).toBe(1);
  expect(cost.verbatim_re_authors, "one touch is not a re-author").toBe(0);
  expect(cost.tokens).toBe(0);
});

test("measureFrictionCost: repeated touches on one subject count as verbatim re-authors; tokens sum best-effort", () => {
  const cost = measureFrictionCost([
    evt("a", "inefficient_feeding", "x", { tokens: 100 }),
    evt("b", "inefficient_feeding", "x", { tokens: 50 }),
    evt("c", "inefficient_feeding", "x"), // no tokens → contributes 0, never fabricated
  ]);
  expect(cost.round_trips).toBe(3);
  expect(cost.verbatim_re_authors).toBe(3);
  expect(cost.tokens, "only real measures sum; missing counts as 0").toBe(150);
});

// ── the below/above surface threshold: BELOW MUST NOT FIRE ─────────────────────

test("costSignalsSurface: below the threshold does NOT fire, at/above the threshold fires", () => {
  expect(FRICTION_COST_SURFACE_THRESHOLD).toBe(2);
  expect(
    costSignalsSurface({ round_trips: 1, verbatim_re_authors: 0, tokens: 0 }),
    "a single cheap round-trip is noise — must NOT fire",
  ).toBe(false);
  expect(
    costSignalsSurface({ round_trips: 2, verbatim_re_authors: 2, tokens: 0 }),
    "at threshold fires",
  ).toBe(true);
});

// ── aggregation: N same-artifact same-category events → ONE observation ─────────

test("deriveFrictionObservations: N same-artifact same-category events collapse to ONE surfaced observation", () => {
  const derived = deriveFrictionObservations([
    evt("e1", "inefficient_feeding", "node-6"),
    evt("e2", "inefficient_feeding", "node-6"),
    evt("e3", "inefficient_feeding", "node-6"),
  ]);
  expect(derived.length, "one aggregate per (category, artifact)").toBe(1);
  expect(derived[0].category).toBe("inefficient_feeding");
  expect(derived[0].artifact).toBe("node-6");
  expect(derived[0].cost.round_trips).toBe(3);
  expect(derived[0].event_ids).toEqual(["e1", "e2", "e3"]);
  expect(derived[0].surfaced, "3 >= threshold → fires").toBe(true);
});

test("deriveFrictionObservations: a SINGLE event is reported but does NOT surface (below MUST NOT fire)", () => {
  const derived = deriveFrictionObservations([evt("solo", "inefficient_feeding", "node-6")]);
  expect(derived.length).toBe(1);
  expect(derived[0].surfaced, "one round-trip is below threshold — never fires").toBe(false);
  expect(prepopulatedObservations(derived), "nothing pre-populated below threshold").toEqual([]);
});

test("deriveFrictionObservations: only REAL-category events feed the walk (untagged legacy events excluded)", () => {
  const derived = deriveFrictionObservations([
    evt("e1", "inefficient_feeding", "node-6"),
    evt("e2", "inefficient_feeding", "node-6"),
    { id: "legacy", note: "no category" }, // untagged → contributes no coverage
  ]);
  expect(derived.length).toBe(1);
  expect(derived[0].event_ids).toEqual(["e1", "e2"]);
});

test("deriveFrictionObservations: distinct categories on the SAME artifact stay distinct observations, ordered canonically", () => {
  const derived = deriveFrictionObservations([
    evt("t1", "tool_should_decide", "node-6"),
    evt("t2", "tool_should_decide", "node-6"),
    evt("i1", "inefficient_feeding", "node-6"),
    evt("i2", "inefficient_feeding", "node-6"),
  ]);
  expect(derived.map((d) => d.category)).toEqual(["tool_should_decide", "inefficient_feeding"]);
});

test("prepopulatedObservations: emits the open_observations shape with a REAL category, never 'trap'", () => {
  const derived = deriveFrictionObservations([
    evt("e1", "inefficient_feeding", "node-6"),
    evt("e2", "inefficient_feeding", "node-6"),
  ]);
  const obs = prepopulatedObservations(derived);
  expect(obs.length).toBe(1);
  expect(FRICTION_CATEGORIES).toContain(obs[0].category);
  expect(obs[0].category).not.toBe("trap");
  expect(obs[0].derived).toBe(true);
  expect(obs[0].artifact).toBe("node-6");
});

// ── stepBoundary event → real category mapping (never 'trap') ───────────────────

test("stepBoundaryFrictionCategory maps every named fact to a REAL category and degrades unknowns safely", () => {
  expect(stepBoundaryFrictionCategory("phase_reemit")).toBe("inefficient_feeding");
  expect(stepBoundaryFrictionCategory("node_quarantine")).toBe("tool_should_decide");
  expect(stepBoundaryFrictionCategory("artifact_rejected")).toBe("tool_should_decide");
  // Unknown fact → the safe "avoidable re-work" default, never undefined, never 'trap'.
  expect(stepBoundaryFrictionCategory("brand_new_backend_fact")).toBe("inefficient_feeding");
  for (const ft of ["phase_reemit", "repair_round", "node_quarantine", "quota_escalation"]) {
    expect(FRICTION_CATEGORIES).toContain(stepBoundaryFrictionCategory(ft));
  }
});

// ── integration: auto-capture PRE-POPULATES the host category walk ──────────────

test("decideFrictionTriage pre-populates a category from N same-artifact mechanical events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-derive-"));
  // PATH-HANDLING (TST-c0e7b3b3): a run id sanitizeRunId actually CHANGES, so the
  // capture→triage→read pipeline is proven to sanitize CONSISTENTLY at every hop
  // (an idempotent id like "run-1" exercises none of the encoding).
  const runId = "run/1:derive";
  try {
    // Two backend facts on the SAME artifact (node-6) → one inefficient_feeding aggregate.
    await captureStepBoundaryFriction(
      dir,
      runId,
      { eventType: "phase_reemit", discriminator: "d1", note: "re-emit", artifact: "node-6" },
      "remediate-code",
    );
    await captureStepBoundaryFriction(
      dir,
      runId,
      { eventType: "repair_round", discriminator: "d2", note: "repair", artifact: "node-6" },
      "remediate-code",
    );

    const decision = await decideFrictionTriage(dir, runId, "remediate-code");
    // inefficient_feeding arrives PRE-COVERED; the other two are still owed.
    expect(decision.missing_categories).toEqual(["ambiguous_direction", "tool_should_decide"]);

    // The pre-populated entry is persisted in the open_observations[] shape the
    // close-out (and the Stop-hook backstop) read: real category, never 'trap'.
    const record = await readRecord(dir, runId);
    const derivedObs = (record.open_observations ?? []).filter((o) => o.derived);
    expect(derivedObs.length).toBe(1);
    expect(derivedObs[0].category).toBe("inefficient_feeding");
    expect(record.open_observations.every((o) => o.category !== "trap")).toBe(true);

    // The render tells the host it was pre-populated (review, don't re-walk).
    expect(buildFrictionTriageBlock(decision)).toContain("pre-populated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decideFrictionTriage: a lone mechanical event does NOT pre-cover its category (below MUST NOT fire)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-derive-"));
  try {
    await captureStepBoundaryFriction(
      dir,
      "run-1",
      { eventType: "phase_reemit", discriminator: "d1", note: "re-emit", artifact: "node-6" },
      "remediate-code",
    );
    const decision = await decideFrictionTriage(dir, "run-1", "remediate-code");
    expect(decision.missing_categories, "one round-trip is below threshold — all owed").toEqual([
      ...FRICTION_CATEGORIES,
    ]);
    const record = await readRecord(dir, "run-1");
    expect((record.open_observations ?? []).filter((o) => o.derived)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decideFrictionTriage: re-derive is idempotent and PRESERVES host-authored observations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-derive-"));
  try {
    const { appendFrictionUnderLock } = await import(
      "../../src/shared/friction/frictionRecord.ts"
    );
    // Host authors an observation of its own.
    await appendFrictionUnderLock(
      dir,
      "run-1",
      (r) => ({
        ...r,
        open_observations: [{ category: "ambiguous_direction", note: "host said so" }],
      }),
      "remediate-code",
    );
    // Two mechanical facts on one artifact accrue after.
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "repair_round", discriminator: "d1", note: "r", artifact: "n6" }, "remediate-code");
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "repair_round", discriminator: "d2", note: "r", artifact: "n6" }, "remediate-code");

    await decideFrictionTriage(dir, "run-1", "remediate-code");
    await decideFrictionTriage(dir, "run-1", "remediate-code"); // second call → idempotent

    const record = await readRecord(dir, "run-1");
    const host = record.open_observations.filter((o) => !o.derived);
    const derived = record.open_observations.filter((o) => o.derived);
    expect(host, "host-authored observation survives the re-derive").toEqual([
      { category: "ambiguous_direction", note: "host said so" },
    ]);
    expect(derived.length, "derived set is recomputed, never duplicated").toBe(1);
    expect(derived[0].category).toBe("inefficient_feeding");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── hook parity: the Stop-gate categories stay in lockstep with the source ──────

test("friction-stop-gate hook FRICTION_CATEGORIES stays in parity with the source of truth", async () => {
  const hookPath = join(HERE, "..", "..", ".claude", "hooks", "friction-stop-gate.mjs");
  const src = await readFile(hookPath, "utf8");
  const match = src.match(/const FRICTION_CATEGORIES = (\[[^\]]*\]);/);
  expect(match, "hook must declare a literal FRICTION_CATEGORIES array").toBeTruthy();
  const hookCategories = JSON.parse(match[1].replace(/'/g, '"'));
  expect(hookCategories, "hook list must equal the single-sourced categories").toEqual([
    ...FRICTION_CATEGORIES,
  ]);
});

// ── INV-SCC-04 / COR-6fd1702f / TST-c0e7b3b3: single-encoding path derivation ──

test("capture→triage round trip with an underscore-bearing run id: pending events and recordPath use the SINGLE canonical file", async () => {
  // `frictionCapturePath` already sanitizes its run-id argument. Triage must
  // therefore pass the RAW run id — pre-sanitizing double-encodes any id that
  // sanitizeRunId actually changes (underscores are escaped, so `run_1` →
  // `run_5f1` → double → `run_5f5f1`): captured events vanish from the triage
  // subject set and the host is directed at a record the locked mutation path
  // never reads, so close-out cannot converge. Real audit run ids carry
  // underscores, so the round trip is pinned on one.
  const dir = await mkdtemp(join(tmpdir(), "friction-single-encode-"));
  const runId = "run_1";
  try {
    await captureStepBoundaryFriction(
      dir,
      runId,
      { eventType: "phase_reemit", discriminator: "d1", note: "re-emit", artifact: "node-1" },
      "remediate-code",
    );

    const decision = await decideFrictionTriage(dir, runId, "remediate-code");

    // The captured mechanical event must surface as a PENDING triage subject —
    // a double-encoded read path silently drops it (empty pending set).
    expect(
      decision.pending.some((s) => s.source === "event"),
      "the captured event must appear in the pending triage subjects",
    ).toBe(true);

    // The host must be pointed at the SAME canonical record file the capture
    // path wrote — one single-encoded derivation, never a re-encoded spelling.
    expect(decision.recordPath).toBe(frictionCapturePath(dir, runId));

    // And that canonical record actually carries the captured event.
    const record = await readRecord(dir, runId);
    expect((record.frictions ?? []).length).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
