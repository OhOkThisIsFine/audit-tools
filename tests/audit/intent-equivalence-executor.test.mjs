// DD-9 — the intent-equivalence executor: status derivation and resolution
// commits (baseline = the revision authority the metadata stamper mirrors).
import { test, expect } from "vitest";

const {
  deriveIntentEquivalenceStatus,
  runIntentEquivalenceResolve,
} = await import("../../src/audit/orchestrator/intentEquivalenceExecutor.ts");
const { normalizeCheckpointForms, computeGateVersion, normalFormHash } =
  await import("../../src/audit/orchestrator/intentCheckpointGate.ts");
const { computeArtifactMetadata } = await import(
  "../../src/audit/orchestrator/artifactMetadata.ts"
);
const { METADATA_SCHEMA_VERSION } = await import(
  "../../src/audit/types/artifactMetadata.ts"
);

function checkpoint(over = {}) {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-07-23T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "Root: /repo, files in scope: 12",
    intent_summary: "full-audit",
    ...over,
  };
}

function baselineFor(cp, revision = 3) {
  const forms = normalizeCheckpointForms(cp);
  return {
    normalized_structured: forms.structured,
    normalized_prose: forms.prose,
    revision,
    gate_version: computeGateVersion(),
  };
}

function bundleWith(cp, baseline, entryRevision = 3) {
  return {
    intent_checkpoint: cp,
    artifact_metadata: {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {
        "intent_checkpoint.json": {
          revision: entryRevision,
          content_hash: "irrelevant-here",
          dependency_revisions: {},
        },
      },
      ...(baseline ? { intent_baseline: baseline } : {}),
    },
  };
}

test("status: absent checkpoint => satisfied; no baseline => stamp_baseline", () => {
  expect(deriveIntentEquivalenceStatus({}).kind).toBe("satisfied");
  expect(deriveIntentEquivalenceStatus(bundleWith(checkpoint(), undefined)).kind).toBe(
    "stamp_baseline",
  );
});

test("status: provenance-only re-confirm => satisfied (no judgment owed)", () => {
  const cp = checkpoint();
  const bundle = bundleWith(
    checkpoint({ confirmed_at: "2027-01-01T00:00:00Z" }),
    baselineFor(cp),
  );
  expect(deriveIntentEquivalenceStatus(bundle).kind).toBe("satisfied");
});

test("status: stale gate version / structured delta / prose delta discriminate correctly", () => {
  const cp = checkpoint();
  const staleGate = bundleWith(cp, { ...baselineFor(cp), gate_version: "old:host:v0" });
  expect(deriveIntentEquivalenceStatus(staleGate).kind).toBe("gate_version_stale");

  const structural = bundleWith(
    checkpoint({ lens_selection: { exclude: ["tests"] } }),
    baselineFor(cp),
  );
  expect(deriveIntentEquivalenceStatus(structural).kind).toBe("structured_changed");

  const prose = bundleWith(
    checkpoint({ scope_summary: "Scope root /repo (12 files)" }),
    baselineFor(cp),
  );
  const status = deriveIntentEquivalenceStatus(prose);
  expect(status.kind).toBe("prose_judgment_pending");
  expect(status.prior_hash).toBe(normalFormHash(baselineFor(cp).normalized_prose));
  expect(status.new_hash).toBe(
    normalFormHash(normalizeCheckpointForms(prose.intent_checkpoint).prose),
  );
});

test("stamp arm: baseline stamped from current, revision mirrors the entry (min 1)", async () => {
  const { hashArtifactValue } = await import(
    "../../src/audit/orchestrator/artifactFreshness.ts"
  );
  const cp = checkpoint();
  const bundle = bundleWith(cp, undefined, 7);
  // Hash-consistent entry: a quiet first contact (a MISMATCHED entry hash is
  // the pending-change case, covered below — it resolves CHANGED instead).
  bundle.artifact_metadata.artifacts["intent_checkpoint.json"].content_hash =
    hashArtifactValue("intent_checkpoint.json", cp);
  const run = runIntentEquivalenceResolve(bundle);
  const baseline = run.updated.artifact_metadata.intent_baseline;
  expect(baseline.revision).toBe(7);
  expect(baseline.normalized_prose).toBe(normalizeCheckpointForms(cp).prose);

  const fresh = runIntentEquivalenceResolve({ intent_checkpoint: cp });
  expect(fresh.updated.artifact_metadata.intent_baseline.revision).toBe(1);
});

test("structured delta / stale gate / headless prose all resolve CHANGED (revision advances)", () => {
  const cp = checkpoint();
  for (const bundle of [
    bundleWith(checkpoint({ must_not_touch: ["secrets/**"] }), baselineFor(cp)),
    bundleWith(cp, { ...baselineFor(cp), gate_version: "old:host:v0" }),
    bundleWith(checkpoint({ intent_summary: "audit it all" }), baselineFor(cp)),
  ]) {
    const run = runIntentEquivalenceResolve(bundle);
    expect(run.updated.artifact_metadata.intent_baseline.revision).toBe(4);
    expect(deriveIntentEquivalenceStatus(run.updated).kind).toBe("satisfied");
  }
});

test("a verdict naming a stale pair is discarded; the obligation stays pending", () => {
  const cp = checkpoint();
  const bundle = bundleWith(
    checkpoint({ scope_summary: "reworded again" }),
    baselineFor(cp),
  );
  const run = runIntentEquivalenceResolve(bundle, {
    verdict: "equivalent",
    judged_pair: { prior_hash: "not-the-pair", new_hash: "still-not" },
  });
  expect(run.updated.artifact_metadata.intent_baseline).toEqual(baselineFor(cp));
  expect(deriveIntentEquivalenceStatus(run.updated).kind).toBe(
    "prose_judgment_pending",
  );
});

test("verdict equivalent: forms advance, revision authority stays put", () => {
  const cp = checkpoint();
  const next = checkpoint({ scope_summary: "Scope root /repo (12 files)" });
  const bundle = bundleWith(next, baselineFor(cp));
  const status = deriveIntentEquivalenceStatus(bundle);
  const run = runIntentEquivalenceResolve(bundle, {
    verdict: "equivalent",
    judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash },
  });
  const baseline = run.updated.artifact_metadata.intent_baseline;
  expect(baseline.revision).toBe(3);
  expect(baseline.normalized_prose).toBe(normalizeCheckpointForms(next).prose);
  expect(deriveIntentEquivalenceStatus(run.updated).kind).toBe("satisfied");
});

test("verdict changed: revision advances so downstreams re-stale exactly once", () => {
  const cp = checkpoint();
  const next = checkpoint({ scope_summary: "now audit only the API layer" });
  const bundle = bundleWith(next, baselineFor(cp));
  const status = deriveIntentEquivalenceStatus(bundle);
  const run = runIntentEquivalenceResolve(bundle, {
    verdict: "changed",
    judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash },
  });
  expect(run.updated.artifact_metadata.intent_baseline.revision).toBe(4);
});

test("metadata stamper mirrors the baseline revision for the intent entry", () => {
  const cp = checkpoint();
  const next = checkpoint({ scope_summary: "reworded but equivalent" });
  // Downstream-visible scenario: prior manifest at revision 3; the host rewrote
  // the checkpoint; an interim metadata pass would ordinarily bump the entry.
  const previous = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {
      "intent_checkpoint.json": {
        revision: 3,
        content_hash: "stale-hash",
        dependency_revisions: {},
      },
    },
    intent_baseline: baselineFor(cp, 3),
  };
  const bundle = { intent_checkpoint: next, artifact_metadata: previous };
  const interim = computeArtifactMetadata(bundle, previous, []);
  // Pending judgment: hash restamps, revision DEFERS (mirrors baseline).
  expect(interim.artifacts["intent_checkpoint.json"].revision).toBe(3);
  expect(interim.artifacts["intent_checkpoint.json"].content_hash).not.toBe(
    "stale-hash",
  );

  // After a judged-changed commit, the mirror advances the entry.
  const status = deriveIntentEquivalenceStatus(bundle);
  const resolved = runIntentEquivalenceResolve(bundle, {
    verdict: "changed",
    judged_pair: { prior_hash: status.prior_hash, new_hash: status.new_hash },
  });
  const after = computeArtifactMetadata(resolved.updated, previous, []);
  expect(after.artifacts["intent_checkpoint.json"].revision).toBe(4);
  expect(after.intent_baseline.revision).toBe(4);
});

test("first contact with a PENDING checkpoint change resolves CHANGED, never absorbs it", () => {
  // Legacy run dir: entry recorded for the OLD intent (hash mismatch with the
  // live checkpoint), no baseline. Stamping at the old revision would let the
  // revision mirror evaporate the downstream staleness the change owes.
  const next = checkpoint({ scope_summary: "a genuinely different scope" });
  const bundle = {
    intent_checkpoint: next,
    artifact_metadata: {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {
        "intent_checkpoint.json": {
          revision: 5,
          content_hash: "hash-of-the-OLD-intent",
          dependency_revisions: {},
        },
      },
    },
  };
  const run = runIntentEquivalenceResolve(bundle);
  expect(run.updated.artifact_metadata.intent_baseline.revision).toBe(6);
});

test("hash-consistent first contact stamps quietly at the entry revision", async () => {
  const { hashArtifactValue } = await import(
    "../../src/audit/orchestrator/artifactFreshness.ts"
  );
  const cp = checkpoint();
  const bundle = {
    intent_checkpoint: cp,
    artifact_metadata: {
      metadata_schema_version: METADATA_SCHEMA_VERSION,
      artifacts: {
        "intent_checkpoint.json": {
          revision: 5,
          content_hash: hashArtifactValue("intent_checkpoint.json", cp),
          dependency_revisions: {},
        },
      },
    },
  };
  const run = runIntentEquivalenceResolve(bundle);
  expect(run.updated.artifact_metadata.intent_baseline.revision).toBe(5);
});

test("the revision mirror never REWINDS below the previous entry revision (gate-flap hardening)", () => {
  const cp = checkpoint();
  // A gate-stale window let ordinary bumps advance the entry to 11 while the
  // baseline froze at 10; the gate then reads current again. The mirror must
  // hold 11, not snap back to 10 (which would mask the interim bumps).
  const previous = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {
      "intent_checkpoint.json": {
        revision: 11,
        content_hash: "interim-hash",
        dependency_revisions: {},
      },
    },
    intent_baseline: baselineFor(cp, 10),
  };
  const bundle = { intent_checkpoint: cp, artifact_metadata: previous };
  const manifest = computeArtifactMetadata(bundle, previous, []);
  expect(manifest.artifacts["intent_checkpoint.json"].revision).toBe(11);
});

test("a stale-gate baseline does NOT mirror (ordinary bump rules apply)", () => {
  const next = checkpoint({ scope_summary: "reworded" });
  const previous = {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {
      "intent_checkpoint.json": {
        revision: 3,
        content_hash: "stale-hash",
        dependency_revisions: {},
      },
    },
    intent_baseline: {
      ...baselineFor(checkpoint(), 3),
      gate_version: "old:host:v0",
    },
  };
  const bundle = { intent_checkpoint: next, artifact_metadata: previous };
  const manifest = computeArtifactMetadata(bundle, previous, []);
  expect(manifest.artifacts["intent_checkpoint.json"].revision).toBe(4);
});
