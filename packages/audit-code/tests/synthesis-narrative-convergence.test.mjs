/**
 * synthesis-narrative-convergence.test.mjs
 *
 * OBL-C006 / CE-005: the synthesis-narrative artifact (and everything feeding
 * the content-hash / state signature) must be canonically serialized before
 * hashing — stable key + array ordering, and ALL non-semantic fields stripped —
 * so a byte-varying-but-semantically-stable narrative yields a STABLE signature.
 * A stable recurring signature must then trip the pre-dispatch no-progress guard
 * (ARC-b8fed771), letting the synthesis <-> narrative loop converge instead of
 * spinning to the run backstop.
 *
 * Coverage:
 *   1. hashArtifactValue("audit-findings.json", …) is invariant under theme/
 *      top-risk REORDERING and added non-semantic fields (generated_at).
 *   2. computeArtifactStateSignature is identical for two metadata manifests
 *      whose narrative-bearing artifacts differ only in non-semantic ways.
 *   3. applyNarrative output: the same narrative supplied in different array
 *      order produces the same canonical content hash for audit-findings.json.
 *   4. checkNoProgressBeforeDispatch FIRES on the second recurrence of a stable
 *      narrative signature (the convergence guarantee).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { hashArtifactValue } = await import(
  "../src/orchestrator/artifactFreshness.ts"
);
const { computeArtifactStateSignature } = await import(
  "../src/orchestrator/artifactMetadata.ts"
);
const { applyNarrative } = await import("../src/reporting/synthesis.ts");
const { checkNoProgressBeforeDispatch } = await import(
  "../src/cli/nextStepCommand.ts"
);
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { writeCoreArtifacts } = await import("../src/io/artifacts.ts");

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "narrative-converge-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A minimal but valid AuditFindingsReport with a couple of findings. */
function baseFindingsReport() {
  return {
    contract_version: "audit-findings/v1alpha1",
    summary: {
      finding_count: 2,
      work_block_count: 0,
      severity_breakdown: { high: 1, medium: 1 },
      audited_file_count: 1,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings: [
      {
        id: "F-1",
        title: "Weak token check",
        severity: "high",
        lens: "security",
        affected_files: [{ path: "src/a.ts", line: 1 }],
        summary: "x",
      },
      {
        id: "F-2",
        title: "Unbounded loop",
        severity: "medium",
        lens: "performance",
        affected_files: [{ path: "src/b.ts", line: 2 }],
        summary: "y",
      },
    ],
    work_blocks: [],
  };
}

/** Two themes + two top-risks, supplied in a given order. */
function narrative(order) {
  const themeA = {
    theme_id: "T-auth",
    title: "Auth weaknesses",
    root_cause: "missing validation",
    finding_ids: ["F-1"],
    suggested_fix_pattern: "validate",
  };
  const themeB = {
    theme_id: "T-perf",
    title: "Performance",
    root_cause: "no bounds",
    finding_ids: ["F-2"],
    suggested_fix_pattern: "bound",
  };
  const risks = ["Risk: auth bypass", "Risk: DoS via loop"];
  return order === "forward"
    ? { themes: [themeA, themeB], executive_summary: "summary", top_risks: risks }
    : {
        themes: [themeB, themeA],
        executive_summary: "summary",
        top_risks: [...risks].reverse(),
      };
}

// ── 1. hash invariance under reordering + non-semantic fields ─────────────────

test("OBL-C006: audit-findings hash is invariant under theme/top-risk reorder and generated_at", () => {
  const forward = applyNarrative(baseFindingsReport(), narrative("forward"));
  const reversed = applyNarrative(baseFindingsReport(), narrative("reversed"));

  // The two enriched reports differ byte-wise (theme/top_risk array order), but
  // are semantically identical. The canonical hash must collapse them.
  assert.notDeepEqual(
    forward.themes.map((t) => t.theme_id),
    reversed.themes.map((t) => t.theme_id),
    "precondition: the two narratives are supplied in different array order",
  );
  assert.equal(
    hashArtifactValue("audit-findings.json", forward),
    hashArtifactValue("audit-findings.json", reversed),
    "reordered-but-equivalent narrative must hash identically",
  );

  // Adding a non-semantic generated_at must not change the hash either.
  assert.equal(
    hashArtifactValue("audit-findings.json", {
      ...forward,
      generated_at: "2026-06-14T00:00:00Z",
    }),
    hashArtifactValue("audit-findings.json", {
      ...forward,
      generated_at: "1999-01-01T00:00:00Z",
    }),
    "generated_at is provenance, not content — must be stripped before hashing",
  );
});

test("OBL-C006: a GENUINE narrative content change still changes the hash", () => {
  const forward = applyNarrative(baseFindingsReport(), narrative("forward"));
  const changed = applyNarrative(baseFindingsReport(), {
    ...narrative("forward"),
    executive_summary: "a materially different executive summary",
  });
  assert.notEqual(
    hashArtifactValue("audit-findings.json", forward),
    hashArtifactValue("audit-findings.json", changed),
    "real semantic change must produce a different hash (no false convergence)",
  );
});

// ── 2. state-signature stability across non-semantic narrative variance ───────

test("OBL-C006: computeArtifactStateSignature is stable across non-semantic narrative variance", () => {
  const forward = applyNarrative(baseFindingsReport(), narrative("forward"));
  const reversed = applyNarrative(baseFindingsReport(), narrative("reversed"));

  const sigOf = (findings) =>
    computeArtifactStateSignature({
      artifact_metadata: {
        artifacts: {
          "audit-findings.json": {
            revision: 1,
            content_hash: hashArtifactValue("audit-findings.json", findings),
            dependency_revisions: {},
          },
          "synthesis-narrative.json": {
            revision: 1,
            content_hash: hashArtifactValue("synthesis-narrative.json", {
              status: "applied",
              theme_count: 2,
              executive_summary_present: true,
              top_risk_count: 2,
            }),
            dependency_revisions: {},
          },
        },
      },
    });

  assert.equal(
    sigOf(forward),
    sigOf(reversed),
    "semantically-stable narrative must yield a stable state signature",
  );
});

// ── 3. synthesis-narrative marker canonicalization ────────────────────────────

test("OBL-C006: synthesis-narrative marker hash strips non-semantic fields", () => {
  const record = {
    status: "applied",
    theme_count: 2,
    executive_summary_present: true,
    top_risk_count: 2,
  };
  assert.equal(
    hashArtifactValue("synthesis-narrative.json", {
      ...record,
      generated_at: "2026-06-14T00:00:00Z",
    }),
    hashArtifactValue("synthesis-narrative.json", record),
    "synthesis-narrative marker must hash equal with/without a provenance stamp",
  );
});

// ── 4. no-progress guard fires on a recurring stable signature ────────────────

test("CE-005 convergence: no-progress guard fires when a stable narrative signature recurs", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });

    // A bundle whose state signature is driven by the (canonicalized) narrative
    // artifacts. We seed a metadata manifest so computeArtifactStateSignature is
    // a real, metadata-bearing signature (not the "no-metadata" bootstrap).
    const enriched = applyNarrative(baseFindingsReport(), narrative("forward"));
    const metadata = {
      artifacts: {
        "audit-findings.json": {
          revision: 1,
          content_hash: hashArtifactValue("audit-findings.json", enriched),
          dependency_revisions: {},
        },
        "synthesis-narrative.json": {
          revision: 1,
          content_hash: hashArtifactValue("synthesis-narrative.json", {
            status: "applied",
            theme_count: 2,
            executive_summary_present: true,
            top_risk_count: 2,
          }),
          dependency_revisions: {},
        },
      },
    };
    const bundle = {
      repo_manifest: {
        repository: { name: "converge" },
        generated_at: "t",
        files: [],
      },
      // A rendered report so the terminal step resolves to a present-report
      // (complete) rather than a bare block — convergence after the contract is
      // already written is success, not failure.
      audit_report: "# Audit Report\n\n## Work blocks\n\n- Done\n",
      artifact_metadata: metadata,
    };
    await writeCoreArtifacts(artDir, bundle);
    const state = deriveAuditState(bundle);

    const dispatchedSignatures = new Set();
    const baseCtx = {
      dispatchedSignatures,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      selectedObligation: "synthesis_narrative_current",
      selectedExecutor: "synthesis_narrative_executor",
    };

    // First encounter: records the signature, does NOT fire (legitimate first
    // dispatch from this state).
    const first = await checkNoProgressBeforeDispatch({ index: 0, ...baseCtx });
    assert.equal(first, undefined, "first dispatch from a fresh state must proceed");

    // The state signature did not change (a byte-varying-but-semantically-stable
    // re-render of the same narrative leaves the canonical hash unchanged), so on
    // the SECOND encounter of the same signature the guard must fire and stop the
    // loop instead of re-dispatching.
    const second = await checkNoProgressBeforeDispatch({ index: 1, ...baseCtx });
    assert.ok(second !== undefined, "guard must fire on the recurring stable signature");
    assert.equal(
      second.kind,
      "complete",
      "with the report already rendered, convergence resolves to complete (report promoted, working dir cleaned)",
    );
  });
});

test("CE-005: no-progress guard records no_progress_detected and stays blocked when no report exists", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });

    // Same stable-narrative signature, but NO rendered report → the terminal step
    // routes to "blocked" and the working dir is NOT promoted/cleaned, so the
    // deterministic-progress.json the guard wrote survives for inspection.
    const enriched = applyNarrative(baseFindingsReport(), narrative("forward"));
    const metadata = {
      artifacts: {
        "audit-findings.json": {
          revision: 1,
          content_hash: hashArtifactValue("audit-findings.json", enriched),
          dependency_revisions: {},
        },
      },
    };
    const bundle = {
      repo_manifest: { repository: { name: "converge2" }, generated_at: "t", files: [] },
      artifact_metadata: metadata,
    };
    await writeCoreArtifacts(artDir, bundle);
    const state = deriveAuditState(bundle);

    const dispatchedSignatures = new Set();
    const baseCtx = {
      dispatchedSignatures,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      selectedObligation: "synthesis_narrative_current",
      selectedExecutor: "synthesis_narrative_executor",
    };

    assert.equal(
      await checkNoProgressBeforeDispatch({ index: 0, ...baseCtx }),
      undefined,
      "first dispatch proceeds",
    );
    const fired = await checkNoProgressBeforeDispatch({ index: 1, ...baseCtx });
    assert.ok(fired !== undefined, "guard fires on recurrence");
    assert.equal(fired.kind, "blocked", "no report → blocked terminal step");

    const progress = JSON.parse(
      await readFile(join(artDir, "steps", "deterministic-progress.json"), "utf8"),
    );
    assert.equal(progress.no_progress_detected, true, "no_progress_detected must be recorded");
    assert.equal(progress.repeated_executor, "synthesis_narrative_executor");
    assert.equal(progress.repeated_obligation, "synthesis_narrative_current");
  });
});

test("ARC-b8fed771: no-progress guard does NOT fire on the bootstrap no-metadata state", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });
    // No artifact_metadata → computeArtifactStateSignature returns "no-metadata".
    const bundle = { repo_manifest: { repository: { name: "boot" }, generated_at: "t", files: [] } };
    await writeCoreArtifacts(artDir, bundle);
    const state = deriveAuditState(bundle);
    const dispatchedSignatures = new Set();
    const ctx = {
      dispatchedSignatures,
      params: { artifactsDir: artDir, root: dir },
      bundle,
      state,
      selectedObligation: "repo_manifest",
      selectedExecutor: "intake_executor",
    };
    // The bootstrap "no-metadata" signature is legitimately revisited by many
    // early deterministic steps; the guard must never fire on it.
    assert.equal(await checkNoProgressBeforeDispatch({ index: 0, ...ctx }), undefined);
    assert.equal(await checkNoProgressBeforeDispatch({ index: 1, ...ctx }), undefined);
    assert.equal(await checkNoProgressBeforeDispatch({ index: 2, ...ctx }), undefined);
  });
});
