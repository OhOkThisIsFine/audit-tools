// DD-9 — the wired intent-equivalence gate's deterministic primitives: the
// structured/prose normal-form split, provenance invisibility, and the
// locally-resolved gate version. (The commit machinery is covered in
// intent-equivalence-executor.test.mjs.)
import { test, expect } from "vitest";

const {
  normalizeCheckpointForms,
  computeGateVersion,
  normalFormHash,
  DEFAULT_NORMALIZE_CONFIG,
  HOST_JUDGE_ID,
} = await import("../../src/audit/orchestrator/intentCheckpointGate.ts");

const baseCheckpoint = {
  schema_version: "intent-checkpoint/v1",
  confirmed_at: "2026-07-23T00:00:00Z",
  confirmed_by: "host",
  scope_summary: "Root: /repo, files in scope: 12",
  intent_summary: "full-audit",
};

test("provenance (confirmed_at/confirmed_by) is invisible to both normal forms", () => {
  const a = normalizeCheckpointForms(baseCheckpoint);
  const b = normalizeCheckpointForms({
    ...baseCheckpoint,
    confirmed_at: "2026-07-24T12:34:56Z",
    confirmed_by: "draft",
  });
  expect(b.structured).toBe(a.structured);
  expect(b.prose).toBe(a.prose);
});

test("prose edge-whitespace is invisible; a real rephrase moves prose only", () => {
  const a = normalizeCheckpointForms(baseCheckpoint);
  const padded = normalizeCheckpointForms({
    ...baseCheckpoint,
    scope_summary: "  Root: /repo, files in scope: 12  ",
  });
  expect(padded.prose).toBe(a.prose);
  expect(padded.structured).toBe(a.structured);

  const rephrased = normalizeCheckpointForms({
    ...baseCheckpoint,
    scope_summary: "Scope root /repo (12 files)",
  });
  expect(rephrased.prose).not.toBe(a.prose);
  expect(rephrased.structured).toBe(a.structured);
});

test("a structured delta (design_review ceiling) moves structured only", () => {
  const a = normalizeCheckpointForms({
    ...baseCheckpoint,
    design_review: { conceptual_depth: "shallow" },
  });
  const b = normalizeCheckpointForms({
    ...baseCheckpoint,
    design_review: { conceptual_depth: "deep", perspectives: 5 },
  });
  expect(b.structured).not.toBe(a.structured);
  expect(b.prose).toBe(a.prose);
});

test("lens_selection / excluded_scope / must_not_touch / filters / disposition_overrides / schema_version are structured", () => {
  for (const delta of [
    { lens_selection: { exclude: ["performance"] } },
    { excluded_scope: [{ path: "vendor/", reason: "vendored" }] },
    { must_not_touch: ["secrets/**"] },
    { filters: { severity: ["high"] } },
    {
      disposition_overrides: [
        { path: "dist/x.js", status: "generated", reason: "build output" },
      ],
    },
    { schema_version: "intent-checkpoint/v2" },
  ]) {
    const a = normalizeCheckpointForms(baseCheckpoint);
    const b = normalizeCheckpointForms({ ...baseCheckpoint, ...delta });
    expect(b.structured, JSON.stringify(delta)).not.toBe(a.structured);
    expect(b.prose, JSON.stringify(delta)).toBe(a.prose);
  }
});

test("constraint_clauses ride the PROSE form (DD-9: host_answer rephrases are judgeable)", () => {
  const a = normalizeCheckpointForms(baseCheckpoint);
  const b = normalizeCheckpointForms({
    ...baseCheckpoint,
    constraint_clauses: [
      {
        clause_id: "c1",
        text: "never touch the billing tables",
        checkpoint_question: "Which tables are billing tables?",
        host_answer: "billing_* in the primary schema",
      },
    ],
  });
  expect(b.prose).not.toBe(a.prose);
  expect(b.structured).toBe(a.structured);
});

test("absent checkpoint normalizes to a stable marker distinct from any present one", () => {
  const absent = normalizeCheckpointForms(undefined);
  const again = normalizeCheckpointForms(undefined);
  expect(absent).toEqual(again);
  const present = normalizeCheckpointForms(baseCheckpoint);
  expect(absent.prose).not.toBe(present.prose);
});

test("gate version is local, defaults to the host judge, and moves with each component", () => {
  const base = computeGateVersion();
  expect(base).toContain(`:${HOST_JUDGE_ID}:`);
  expect(computeGateVersion({ judgeId: "host" })).toBe(base);
  expect(computeGateVersion({ judgeId: "other" })).not.toBe(base);
  expect(
    computeGateVersion({ promptTemplateVersion: "intent-checkpoint-judge-prompt/v9" }),
  ).not.toBe(base);
  expect(
    computeGateVersion({
      normalizeConfig: { ...DEFAULT_NORMALIZE_CONFIG, version: "bumped/v3" },
    }),
  ).not.toBe(base);
});

test("normalize-config field coverage is EXHAUSTIVE over the IntentCheckpoint schema (reviewer F3)", async () => {
  // The revision mirror makes an omitted field permanently invisible to
  // downstream staleness (forms unchanged ⇒ equivalence satisfied ⇒ revision
  // frozen), so the union of the two lists + the stripped provenance pair must
  // cover EVERY schema field — a new field must be classified in the same
  // commit that adds it.
  const { IntentCheckpointSchema } = await import(
    "../../src/shared/types/intentCheckpoint.ts"
  );
  const covered = new Set([
    ...DEFAULT_NORMALIZE_CONFIG.structuredFields,
    ...DEFAULT_NORMALIZE_CONFIG.proseFields,
    "confirmed_at",
    "confirmed_by",
  ]);
  const schemaFields = Object.keys(IntentCheckpointSchema.shape).sort();
  expect([...covered].sort()).toEqual(schemaFields);
});

test("normalFormHash is deterministic and content-sensitive", () => {
  const forms = normalizeCheckpointForms(baseCheckpoint);
  expect(normalFormHash(forms.prose)).toBe(normalFormHash(forms.prose));
  expect(normalFormHash(forms.prose)).not.toBe(normalFormHash(forms.structured));
});
