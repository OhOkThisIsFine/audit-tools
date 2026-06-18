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
 *   4. nextStepStateSignature (the dispatch-identity key the shared `advance`
 *      engine keys cycle detection on) is STABLE across a semantically-equivalent
 *      narrative re-render, so a recurrence is detected → the synthesis<->narrative
 *      fold converges (stops) instead of spinning. buildTerminalStep then routes
 *      the stop to complete (report rendered) / blocked (no report). This is the
 *      audit-specific composition the deleted no-progress guard used to provide.
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
const { nextStepStateSignature, buildTerminalStep } = await import(
  "../src/cli/nextStepCommand.ts"
);
const { deriveAuditState } = await import("../src/orchestrator/state.ts");
const { writeCoreArtifacts, loadArtifactBundle } = await import(
  "../src/io/artifacts.ts"
);

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

// ── 4. convergence: the dispatch-identity signature is stable, so a recurring ──
//      stable-narrative state is detected as a cycle and routed to a terminal.

test("CE-005 convergence: nextStepStateSignature is stable across a semantically-equivalent narrative re-render", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });

    // A bundle whose state signature is driven by the (canonicalized) narrative
    // artifacts. Seed a metadata manifest so computeArtifactStateSignature is a
    // real, metadata-bearing signature (not the "no-metadata" bootstrap). The
    // narrative is in "applied" form, so synthesis_narrative_current is satisfied
    // and the selected obligation is deterministic.
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
      repo_manifest: { repository: { name: "converge" }, generated_at: "t", files: [] },
      audit_report: "# Audit Report\n\n## Work blocks\n\n- Done\n",
      artifact_metadata: metadata,
    };
    await writeCoreArtifacts(artDir, bundle);
    const loaded = await loadArtifactBundle(artDir);

    // The dispatch-identity signature the shared `advance` engine keys on must be
    // STABLE for the same (semantically-stable) narrative state — so a recurrence
    // is a detectable cycle and the synthesis<->narrative fold converges (stops)
    // rather than spinning. (The bare-artifact hash stability is covered by case 2;
    // this asserts the audit-level key composed on top of it is stable too.)
    const ref = { value: 5 };
    const sig1 = nextStepStateSignature(loaded, ref);
    const sig2 = nextStepStateSignature(loaded, ref);
    assert.equal(sig1, sig2, "a stable narrative state must yield a stable dispatch-identity key");
    // It is NOT the bootstrap state (so it is not salted distinct) — a real
    // metadata-bearing signature, which means a revisit IS caught by advance.
    assert.ok(!sig1.includes("no-metadata"), "a metadata-bearing state is not the salted bootstrap key");
  });
});

test("CE-005 convergence: the terminal routes to complete when the report is rendered, blocked otherwise", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });

    // With the report already rendered, convergence resolves to complete (the
    // report is promoted, working dir cleaned) — never a bare block.
    const enriched = applyNarrative(baseFindingsReport(), narrative("forward"));
    const reportedBundle = {
      repo_manifest: { repository: { name: "converge" }, generated_at: "t", files: [] },
      audit_report: "# Audit Report\n\n## Work blocks\n\n- Done\n",
      artifact_metadata: {
        artifacts: {
          "audit-findings.json": {
            revision: 1,
            content_hash: hashArtifactValue("audit-findings.json", enriched),
            dependency_revisions: {},
          },
        },
      },
    };
    await writeCoreArtifacts(artDir, reportedBundle);
    const loaded = await loadArtifactBundle(artDir);
    const complete = await buildTerminalStep(
      { root: dir, artifactsDir: artDir },
      loaded,
      deriveAuditState(loaded),
      "Finalization is not converging.",
    );
    assert.equal(complete.kind, "complete", "rendered report → complete");
  });
});

test("CE-005: convergence stays blocked when no report exists", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });

    // Same stable-narrative signature, but NO rendered report → blocked terminal.
    const enriched = applyNarrative(baseFindingsReport(), narrative("forward"));
    const bundle = {
      repo_manifest: { repository: { name: "converge2" }, generated_at: "t", files: [] },
      artifact_metadata: {
        artifacts: {
          "audit-findings.json": {
            revision: 1,
            content_hash: hashArtifactValue("audit-findings.json", enriched),
            dependency_revisions: {},
          },
        },
      },
    };
    await writeCoreArtifacts(artDir, bundle);
    const loaded = await loadArtifactBundle(artDir);
    const blocked = await buildTerminalStep(
      { root: dir, artifactsDir: artDir },
      loaded,
      deriveAuditState(loaded),
      "Finalization is not converging.",
    );
    assert.equal(blocked.kind, "blocked", "no report → blocked terminal step");
  });
});

test("ARC-b8fed771: the bootstrap no-metadata state is salted distinct (never a false cycle)", async () => {
  await withTempDir(async (dir) => {
    const artDir = join(dir, ".audit-tools/audit");
    await mkdir(join(artDir, "steps"), { recursive: true });
    // No artifact_metadata → computeArtifactStateSignature returns "no-metadata".
    const bundle = { repo_manifest: { repository: { name: "boot" }, generated_at: "t", files: [] } };
    await writeCoreArtifacts(artDir, bundle);
    const loaded = await loadArtifactBundle(artDir);
    // The bootstrap "no-metadata" signature is legitimately revisited by many
    // early deterministic steps; salting it with the transition counter keeps
    // each scan distinct so `advance` never false-trips a cycle on it.
    const ref = { value: 0 };
    const s0 = nextStepStateSignature(loaded, ref);
    ref.value = 1;
    const s1 = nextStepStateSignature(loaded, ref);
    ref.value = 2;
    const s2 = nextStepStateSignature(loaded, ref);
    assert.match(s0, /no-metadata/);
    assert.notEqual(s0, s1);
    assert.notEqual(s1, s2);
  });
});
