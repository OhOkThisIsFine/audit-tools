import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureStepBoundaryFriction, stepBoundaryEventId } = await import(
  "../../src/shared/friction/stepBoundaryCapture.ts"
);
const { frictionCapturePath } = await import(
  "../../src/shared/io/frictionCapture.ts"
);
const { decideFrictionTriage, recordFrictionDisposition, buildFrictionTriageBlock } =
  await import("../../src/shared/friction/triage.ts");

async function readRecord(dir, runId) {
  return JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
}

// ── CE-006: structured, percent-encoded, collision-free event id ───────────────

test("stepBoundaryEventId percent-encodes each component (a ':'-bearing discriminator is unambiguous)", () => {
  // A discriminator that itself contains the join delimiter must NOT flatten the
  // key — two distinct facts must never collapse to one id.
  const a = stepBoundaryEventId("repair_round", "run-1", "contractA:attempt-1");
  const b = stepBoundaryEventId("repair_round", "run-1", "contractA:attempt:1");
  assert.notEqual(a, b, "distinct discriminators must yield distinct ids");
  // The structured id has exactly three top-level segments (event_type, runId,
  // discriminator) — the discriminator's ':' is encoded, never a raw delimiter.
  assert.equal(a.split(":").length, 3, "discriminator ':' must be encoded, not raw");
  assert.equal(b.split(":").length, 3);
});

test("stepBoundaryEventId is injective across components (no two distinct facts share a key)", () => {
  const ids = new Set([
    stepBoundaryEventId("phase_reemit", "r", "x"),
    stepBoundaryEventId("phase_reemit", "r:x", ""),   // would collide under naive join
    stepBoundaryEventId("phase_reemit", "r", ":x"),
    stepBoundaryEventId("artifact_rejected", "r", "x"),
  ]);
  assert.equal(ids.size, 4, "every distinct {type,run,disc} triple is a distinct id");
});

test("stepBoundaryEventId is deterministic (stable across calls → de-dup works)", () => {
  assert.equal(
    stepBoundaryEventId("no_change_merge", "run-1", "node-7"),
    stepBoundaryEventId("no_change_merge", "run-1", "node-7"),
  );
});

// ── CE-005: every backend fact routes through the one chokepoint ───────────────

test("captureStepBoundaryFriction routes a named fact through the sink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sb-"));
  try {
    await captureStepBoundaryFriction(
      dir,
      "run-1",
      { eventType: "phase_reemit", discriminator: "test_validator_plan:attempt-3", note: "phase re-emitted same errors" },
      "remediate-code",
    );
    const raw = await readRecord(dir, "run-1");
    assert.equal(raw.frictions.length, 1);
    assert.equal(
      raw.frictions[0].id,
      stepBoundaryEventId("phase_reemit", "run-1", "test_validator_plan:attempt-3"),
    );
    assert.equal(raw.frictions[0].category, "trap", "defaults to trap when unset");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureStepBoundaryFriction de-dups a re-entrant pass (idempotent, INV-O1-6)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sb-"));
  try {
    const fact = { eventType: "repair_round", discriminator: "c:attempt-1:patch", note: "repair fired" };
    await captureStepBoundaryFriction(dir, "run-1", fact, "remediate-code");
    await captureStepBoundaryFriction(dir, "run-1", fact, "remediate-code");
    const raw = await readRecord(dir, "run-1");
    assert.equal(raw.frictions.length, 1, "the same fact must record exactly once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two distinct facts whose discriminators differ only by ':' both record (no flatten)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sb-"));
  try {
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "repair_round", discriminator: "a:b", note: "x" }, "remediate-code");
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "repair_round", discriminator: "a:b:", note: "y" }, "remediate-code");
    const raw = await readRecord(dir, "run-1");
    assert.equal(raw.frictions.length, 2, "distinct facts must not collapse to one key");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-O1-5: best-effort / non-fatal ──────────────────────────────────────────

test("captureStepBoundaryFriction is best-effort: a bad dir is swallowed, never throws", async () => {
  await assert.doesNotReject(
    captureStepBoundaryFriction(
      "\0not-a-dir",
      "run-1",
      { eventType: "no_change_merge", discriminator: "n1", note: "x" },
      "remediate-code",
    ),
  );
});

// ── per-event reconciliation: chokepoint feeds decideFrictionTriage ─────────────

test("backend facts captured through the chokepoint surface as per-event pending subjects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sb-"));
  try {
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "phase_reemit", discriminator: "d1", note: "a" }, "remediate-code");
    await captureStepBoundaryFriction(dir, "run-1", { eventType: "artifact_rejected", discriminator: "d2", note: "b" }, "remediate-code");

    let decision = await decideFrictionTriage(dir, "run-1", "remediate-code");
    assert.equal(decision.action, "dispose", "N>=1 events → blocks until disposed");
    assert.equal(decision.pending.length, 2, "each event is an individual pending subject");

    // Disposing ONE id shrinks pending by exactly one (per-event reconciliation).
    await recordFrictionDisposition(
      dir,
      "run-1",
      { target_id: decision.pending[0].id, disposition: "keep" },
      "remediate-code",
    );
    decision = await decideFrictionTriage(dir, "run-1", "remediate-code");
    assert.equal(decision.pending.length, 1, "one disposition removes exactly one subject");

    // The block lists every remaining pending id (no blanket 'no friction').
    const block = buildFrictionTriageBlock(decision);
    assert.ok(block.includes(decision.pending[0].id), "block surfaces each pending id");
    assert.ok(decision.needs_open_observations, "≥1 open observation still required");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zero backend events still blocks until ≥1 open observation (no false-green)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "friction-sb-"));
  try {
    const decision = await decideFrictionTriage(dir, "run-1", "remediate-code");
    assert.equal(decision.action, "dispose", "empty-set must NOT trivially dispose");
    assert.equal(decision.pending.length, 0);
    assert.ok(decision.needs_open_observations, "free-form channel required every run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
