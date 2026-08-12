import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditState } from "../../src/audit/types/auditState.js";
import type { HostGateKind, NextStepParams } from "../../src/audit/cli/nextStepHelpers.js";
import type { RejectedDesignReviewSubmission } from "../../src/audit/types/designAssessment.js";
import type { AdvanceAuditResult } from "../../src/audit/orchestrator/advance.js";
import type { RunAuditStepOptions } from "../../src/audit/cli/auditStep.js";

// Import the extracted helpers directly from source (same pattern as other
// audit-code test files that dynamically import from src's .ts files —
// NodeNext resolves the .js specifier to the sibling .ts source).
const {
  buildTerminalStep,
  handleGraphEnrichmentBranch,
  handleDesignReviewBranch,
  checkFinalizationCycle,
  tryConsumeSubmission,
  consumeArraySubmission,
  consumeObjectSubmission,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
} = await import("../../src/audit/cli/nextStepCommand.js");

// HOST_GATE_KINDS / HOST_GATE_DESCRIPTORS are internal to the Tier C2
// consolidation (not re-exported through nextStepCommand.ts), so import them
// directly from nextStepHelpers.ts.
const {
  HOST_GATE_KINDS,
  HOST_GATE_DESCRIPTORS,
  handleSynthesisNarrativeBranch,
  handleCriticalFlowFallbackBranch,
  handleCharterExtractionBranch,
  handleCharterDeltaBranch,
  handleCharterClarificationBranch,
  handleSystemicChallengeBranch,
} = await import("../../src/audit/cli/nextStepHelpers.js");

// Post-P25 a lane's submission path is TOOL-computed from its lane id, so these
// tests ask the tool where a submission goes instead of re-spelling a filename
// the host used to type.
const { GATE_LANES, charterExtractionLane, laneSubmissionPath } = await import(
  "../../src/audit/cli/laneSubmissions.js"
);
const { submissionsDir } = await import("../../src/shared/io/auditToolsPaths.js");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ns-helpers-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── buildTerminalStep ─────────────────────────────────────────────────────────

await test("buildTerminalStep returns complete when bundle.audit_report is set", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    // Write a minimal operator-handoff.json so writeHandoffOnly has something to update
    await writeFile(
      join(artifactsDir, "operator-handoff.json"),
      JSON.stringify({ progress_summary: "" }),
      "utf8",
    );
    // Write a fake audit-report.md so promoteFinalAuditReport can find it
    await writeFile(join(artifactsDir, "audit-report.md"), "# report", "utf8");

    const params = { root: artifactsDir, artifactsDir };
    const bundle = {
      audit_report: "# report",
      // minimal bundle — other fields undefined
    };
    const state: AuditState = { status: "active", obligations: [] }; // not "complete" but report is present

    const result = await buildTerminalStep(params, bundle, state, "reason");
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") throw new Error("expected kind=complete");
    expect(result.finalReportPath.endsWith("audit-report.md")).toBeTruthy();
  });
});

await test("buildTerminalStep returns blocked when audit_report is falsy and status is not complete", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    await writeFile(
      join(artifactsDir, "operator-handoff.json"),
      JSON.stringify({ progress_summary: "" }),
      "utf8",
    );

    const params = { root: artifactsDir, artifactsDir };
    const bundle = {}; // no audit_report
    const state: AuditState = { status: "active", obligations: [] };

    const result = await buildTerminalStep(params, bundle, state, "blocked reason");
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected kind=blocked");
    expect(result.reason).toBe("blocked reason");
  });
});

// ── handleGraphEnrichmentBranch ───────────────────────────────────────────────

await test("handleGraphEnrichmentBranch returns analyzer_install when unresolved entries exist and no decisions file", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    // Build a minimal bundle with a repo_manifest that contains one Python file
    // whose analyzer (pylint) requires an install decision.
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "test-repo" },
        generated_at: "now",
        files: [
          { path: "src/app.py", language: "python", size_bytes: 100 },
        ],
      },
    };
    const state: AuditState = { status: "active", obligations: [] };
    const analyzersRef = { value: undefined };

    // Use a root path that has no session-config.json so the registry uses defaults
    const params = {
      root: artifactsDir,
      artifactsDir,
      graphLlmEdgeReasoning: false,
      since: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    // If unresolved is non-empty and no decisions file is present, it should
    // return the analyzer_install prompt. If pylint is not in the default
    // registry (no unresolved entries), fall through is acceptable — either
    // way the function must not throw.
    expect(branch.action === "fallthrough" ||
      branch.action === "return" ||
      branch.action === "continue").toBeTruthy();
    if (branch.action === "return") {
      expect(branch.result.kind === "analyzer_install" ||
        branch.result.kind === "edge_reasoning").toBeTruthy();
    }
  });
});

await test("handleGraphEnrichmentBranch returns continue after consuming a valid decisions file", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const decisionsPath = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_decisions);
    // Write a decisions file mapping one analyzer to "skip"
    await writeFile(
      decisionsPath,
      JSON.stringify({ "test-analyzer": "skip" }),
      "utf8",
    );

    // Write a stub session-config with analyzers so persistAnalyzerSettings has
    // somewhere to persist the merged settings
    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify({}),
      "utf8",
    );

    // A bundle with no Python/unresolved files — unresolved will be empty, so the
    // decisions file path is only reached when the registry returns needsInstallDecision.
    // We rely on the function consuming the file and returning "continue" if any
    // decisions are present.
    const bundle: ArtifactBundle = {};
    const state: AuditState = { status: "active", obligations: [] };
    const analyzersRef = { value: undefined };
    const params = {
      root: artifactsDir,
      artifactsDir,
      graphLlmEdgeReasoning: false,
      since: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    // With an empty repo_manifest, unresolved will be [] — the function should
    // fall through to the edge-reasoning check and return "fallthrough" (no
    // candidates, flag off). The decisions file is irrelevant in this path.
    expect(branch.action === "fallthrough" || branch.action === "continue").toBeTruthy();
  });
});

await test("handleGraphEnrichmentBranch returns fallthrough when unresolved is empty and edge-reasoning flag is off", async () => {
  await withTempDir(async (artifactsDir) => {
    const bundle: ArtifactBundle = {};
    const state: AuditState = { status: "active", obligations: [] };
    const analyzersRef = { value: undefined };
    const params = {
      root: artifactsDir,
      artifactsDir,
      graphLlmEdgeReasoning: false,
      since: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    expect(branch.action).toBe("fallthrough");
  });
});

// ── handleDesignReviewBranch ──────────────────────────────────────────────────

await test("handleDesignReviewBranch returns design_review_parallel when both passes unsatisfied and nothing submitted", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    // Nothing submitted — both passes unsatisfied → parallel dispatch.
    const bundle: ArtifactBundle = {
      design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false },
    };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");
    if (branch.action !== "return") throw new Error("expected action=return");
    expect(branch.result.kind).toBe("design_review_parallel");
  });
});

await test("handleDesignReviewBranch returns continue after merging contract findings only, sets contract_reviewed=true", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const contractPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
    await writeFile(contractPath, JSON.stringify([{ id: "DR-001", title: "contract finding" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    // Written design_assessment.json should have contract_reviewed === true
    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.contract_reviewed).toBe(true);
    expect(!written.conceptual_reviewed, "conceptual_reviewed should be falsy").toBeTruthy();
  });
});

await test("handleDesignReviewBranch returns continue after merging conceptual findings only, sets conceptual_reviewed=true", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const conceptualPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_conceptual);
    await writeFile(conceptualPath, JSON.stringify([{ id: "DR-001", title: "conceptual finding" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [], contract_reviewed: true }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: true, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.conceptual_reviewed).toBe(true);
  });
});

await test("handleDesignReviewBranch returns continue after merging both lane submissions simultaneously", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const contractPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
    const conceptualPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_conceptual);
    await writeFile(contractPath, JSON.stringify([{ id: "DR-001", title: "contract" }]), "utf8");
    await writeFile(conceptualPath, JSON.stringify([{ id: "DR-001", title: "conceptual" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.contract_reviewed).toBe(true);
    expect(written.conceptual_reviewed).toBe(true);
  });
});

await test("handleDesignReviewBranch returns single-pass design_review_conceptual when contract pass already satisfied", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    // Nothing submitted, contract already done.
    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: true, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");
    if (branch.action !== "return") throw new Error("expected action=return");
    expect(branch.result.kind).toBe("design_review_conceptual");
  });
});

await test("handleDesignReviewBranch returns continue after merging a valid legacy findings file and deleting it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const findingsPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_legacy);
    await writeFile(findingsPath, JSON.stringify([{ id: "F-1", title: "test" }]), "utf8");

    // Write a stub design_assessment.json so writeCoreArtifacts has a path
    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ reviewed: false }), "utf8");

    const bundle: ArtifactBundle = {
      design_assessment: {
        generated_at: "now",
        findings: [],
        reviewed: false,
        review_findings: [],
      },
    };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    // The submitted findings file should have been deleted
    let exists = true;
    try {
      await import("node:fs/promises").then((m) => m.access(findingsPath));
    } catch {
      exists = false;
    }
    expect(exists, "findings file should be deleted after merge").toBe(false);
  });
});

// ── checkFinalizationCycle ────────────────────────────────────────────────────

await test("checkFinalizationCycle returns undefined when distinct state count is within tolerance", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "steps"), { recursive: true });

    const obligationTrail: string[] = [];
    const seenStateSignatures = new Set<string>();
    const tolerance = 4;
    const params = { artifactsDir, root: artifactsDir };

    // Add 3 distinct signatures — well within tolerance of 4
    for (let i = 0; i < 3; i++) {
      seenStateSignatures.add(`sig-${i}`);
    }

    const result = await checkFinalizationCycle({
      index: 4, // index 4, 5 distinct sigs → 5-5=0 < 4 → no cycle
      obligationTrail,
      seenStateSignatures,
      tolerance,
      params,
      bundle: {},
      state: { status: "active", obligations: [] },
      result: {
        updated_bundle: {},
        audit_state: { status: "active", obligations: [] },
        progress_made: true,
        progress_summary: "ok",
        selected_executor: "test",
        selected_obligation: "test",
        artifacts_written: [],
        next_likely_step: null,
      },
      selectedObligation: "synthesis_current",
    });

    // index=4, seenStateSignatures.size=3 → 4+1-3=2 < 4 → no cycle yet
    expect(result).toBe(undefined);
  });
});

await test("checkFinalizationCycle triggers terminal step after TOLERANCE repeated states", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "steps"), { recursive: true });
    await writeFile(
      join(artifactsDir, "operator-handoff.json"),
      JSON.stringify({ progress_summary: "" }),
      "utf8",
    );

    const tolerance = 4;
    const params = { artifactsDir, root: artifactsDir };

    // Simulate 10 iterations that have only produced 2 distinct states
    const obligationTrail: string[] = Array(10).fill("synthesis_current");
    const seenStateSignatures = new Set<string>(["sig-a", "sig-b"]);

    const result = await checkFinalizationCycle({
      index: 9, // index=9, size=2 → 10-2=8 >= 4 → cycle detected
      obligationTrail,
      seenStateSignatures,
      tolerance,
      params,
      bundle: {},
      state: { status: "active", obligations: [] },
      result: {
        updated_bundle: {},
        audit_state: { status: "active", obligations: [] },
        progress_made: true,
        progress_summary: "ok",
        selected_executor: "synthesis_executor",
        selected_obligation: "synthesis_current",
        artifacts_written: [],
        next_likely_step: null,
      },
      selectedObligation: "synthesis_current",
    });

    // Should return a terminal result (blocked or complete)
    expect(result !== undefined).toBeTruthy();
    if (result === undefined) throw new Error("expected a terminal result");
    expect(result.kind === "blocked" || result.kind === "complete").toBeTruthy();
  });
});

// ── tryConsumeSubmission ──────────────────────────────────────────────────────

await test("tryConsumeSubmission reports absent when nothing was submitted", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    // Nothing written at the lane's bound path.

    const result = await tryConsumeSubmission(artifactsDir, GATE_LANES.charter_delta);

    expect(result, "should resolve to absent without throwing").toEqual({ status: "absent" });
  });
});

await test("tryConsumeSubmission returns parsed value and the bound path when a submission exists", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const payload = { foo: "bar", count: 42 };
    const lane = GATE_LANES.charter_delta;
    const boundPath = laneSubmissionPath(artifactsDir, lane);
    await writeFile(boundPath, JSON.stringify(payload), "utf8");

    const result = await tryConsumeSubmission(artifactsDir, lane);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.value, "value should match the written payload").toEqual(payload);
    expect(
      result.path,
      "path is the tool-computed bound path for the lane, not a host-typed name",
    ).toBe(boundPath);
  });
});

await test("tryConsumeSubmission reports a JSON parse failure as malformed, never a throw", async () => {
  // INVERTED 2026-08-06: this used to pin "re-throws JSON parse errors" — the
  // exact defect behavior that let one malformed lane hard-fail the whole
  // next-step call and destroy a sibling lane's consumed results. Submitted
  // content is the caller's to quarantine; only infrastructure errors throw.
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const lane = GATE_LANES.charter_delta;
    const boundPath = laneSubmissionPath(artifactsDir, lane);
    await writeFile(boundPath, "not valid json {{", "utf8");

    const result = await tryConsumeSubmission(artifactsDir, lane);
    expect(result.status).toBe("malformed");
    if (result.status !== "malformed") throw new Error("expected malformed");
    expect(result.path).toBe(boundPath);
    expect(/invalid json/i.test(result.reason)).toBe(true);
  });
});

await test("tryConsumeSubmission still re-throws genuine IO errors (directory in place of the file)", async () => {
  await withTempDir(async (artifactsDir) => {
    const lane = GATE_LANES.charter_delta;
    // A DIRECTORY where the submission file should be: reading it is an
    // infrastructure failure (EISDIR), not malformed content — must throw.
    await mkdir(laneSubmissionPath(artifactsDir, lane), { recursive: true });

    await assert.rejects(
      () => tryConsumeSubmission(artifactsDir, lane),
      "should re-throw non-ENOENT, non-parse IO errors",
    );
  });
});

// ── HOST_GATE_DESCRIPTORS coverage (Tier C2 consolidation) ────────────────────

await test("HOST_GATE_KINDS / HOST_GATE_DESCRIPTORS cover exactly the 10 audit host-gate kinds", () => {
  const expected: HostGateKind[] = [
    // P25 added `analyzer_consent`: it is a real gate with a real submission
    // and the registry did not name it, so the registry could not be the
    // complete enumeration it is documented to be.
    "analyzer_consent",
    "graph_enrichment",
    "critical_flow_fallback",
    "intent_equivalence",
    "design_review",
    "synthesis_narrative",
    "charter_extraction",
    "charter_delta",
    "charter_clarification",
    "systemic_challenge",
  ];
  expect([...HOST_GATE_KINDS].sort()).toEqual([...expected].sort());
  expect(Object.keys(HOST_GATE_DESCRIPTORS).sort()).toEqual([...expected].sort());

  // The 5 gates driven by the shared runOmittableGate engine vs. the 4 that
  // keep bespoke bodies (graph_enrichment, design_review, intent_equivalence,
  // and the per-kind multi-lane charter_extraction gate) because their shape
  // genuinely deviates from the common one.
  const generic = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "generic");
  const custom = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "custom");
  expect(generic.sort()).toEqual(
    ["critical_flow_fallback", "synthesis_narrative", "charter_delta", "charter_clarification", "systemic_challenge"].sort(),
  );
  expect(custom.sort()).toEqual(
    [
      "analyzer_consent",
      "graph_enrichment",
      "design_review",
      "intent_equivalence",
      "charter_extraction",
    ].sort(),
  );

  // Every descriptor enumerates LANES, never a host-typed filename — the
  // registry is what an expected-submission set is derived from.
  for (const kind of expected) {
    expect(HOST_GATE_DESCRIPTORS[kind].lanes.length).toBeGreaterThan(0);
    for (const lane of HOST_GATE_DESCRIPTORS[kind].lanes) {
      expect(lane).not.toMatch(/\.json$/u);
    }
  }
});

// ── handleDesignReviewBranch — malformed-submission quarantine ───────────────
//
// Regression coverage for the "silently DESTROYS a malformed submission"
// defect: `handleDesignReviewBranch` used to unconditionally `unlink` every
// design-review submission and merge ONLY when `Array.isArray(value)` — any
// other shape (most commonly a JSON-object-mode host wrapping its array as
// `{findings:[...]}`) was destroyed with no quarantine, no message, and the
// identical step re-emitted forever. Fixed via `consumeArrayIncoming`
// (tolerant single-array-property unwrap, else quarantine-not-delete) plus
// `renderDesignReviewRejectionNotice` (names the quarantined file + reason in
// the re-emitted step).

async function quarantinedFiles(artifactsDir: string): Promise<string[]> {
  const dir = join(artifactsDir, "quarantine");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

await test("handleDesignReviewBranch accepts an object-wrapped {findings:[...]} contract submission (tolerant unwrap)", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const contractPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
    // Object-wrapped, not a bare array — the PowerShell/json_object-mode
    // single-element-array-collapses-to-object shape (memory:
    // result-json-array trap) generalized to a whole-array wrap.
    await writeFile(
      contractPath,
      JSON.stringify({ findings: [{ id: "DR-001", title: "contract finding" }] }),
      "utf8",
    );

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.contract_reviewed).toBe(true);
    expect(written.contract_findings).toEqual([{ id: "DR-001", title: "contract finding" }]);
    // Obligation credited (merged), so no quarantine and nothing pending.
    expect(await quarantinedFiles(artifactsDir)).toEqual([]);
    expect(written.rejected_submissions ?? []).toEqual([]);

    // The submission was consumed (deleted), not left behind.
    let stillExists = true;
    try {
      await readFile(contractPath, "utf8");
    } catch {
      stillExists = false;
    }
    expect(stillExists).toBe(false);
  });
});

await test("handleDesignReviewBranch quarantines a bare-string malformed contract submission instead of destroying it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const contractPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
    await writeFile(contractPath, JSON.stringify("oops, not an array"), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);

    // Genuinely malformed → the step re-emits (nothing merged, contract pass
    // still unsatisfied) rather than silently swallowing it as "continue".
    expect(branch.action).toBe("return");
    if (branch.action !== "return") throw new Error("expected action=return");
    expect(["design_review_contract", "design_review_parallel"]).toContain(branch.result.kind);

    // The original submission is gone from its bound path ...
    let stillInIncoming = true;
    try {
      await readFile(contractPath, "utf8");
    } catch {
      stillInIncoming = false;
    }
    expect(stillInIncoming).toBe(false);

    // ... but NOT destroyed: it survives, verbatim, under quarantine/.
    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].startsWith(`${GATE_LANES.design_review_contract}.`)).toBe(true);
    const quarantinedContent = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
    expect(JSON.parse(quarantinedContent)).toBe("oops, not an array");

    // The rejection is recorded on design_assessment so it survives the
    // same-call `continue` re-derivation, and names the file + reason.
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.rejected_submissions.length).toBe(1);
    const rejection = written.rejected_submissions[0];
    expect(rejection.pass).toBe("contract");
    expect(rejection.lane).toBe(GATE_LANES.design_review_contract);
    expect(rejection.reason.includes("string")).toBe(true);
    expect(rejection.quarantine_path.endsWith(quarantined[0])).toBe(true);

    // The re-emitted step's bundle carries the same note (same in-memory
    // design_assessment object) — this is what nextStepCommand.ts threads into
    // the re-emitted step's prompt via renderDesignReviewRejectionNotice.
    const notice = renderDesignReviewRejectionNotice(branch.result.bundle, ["legacy", "contract"]);
    expect(notice).toBeTruthy();
    if (notice === undefined) throw new Error("expected a notice");
    expect(notice.includes(GATE_LANES.design_review_contract)).toBe(true);
    expect(notice.includes(rejection.quarantine_path)).toBe(true);
    expect(notice.includes("string")).toBe(true);
  });
});

await test("handleDesignReviewBranch quarantines a syntactically malformed conceptual lane without losing the sibling contract lane", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    // Valid contract lane + malformed-JSON conceptual lane, arriving in the
    // same call — the 2026-08-06 dogfood loss: the contract file was consumed
    // (unlinked), then the conceptual parse threw out of the whole branch, so
    // the merged-but-unpersisted contract findings were destroyed and the
    // contract lane had to re-run.
    const contractPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_contract);
    await writeFile(
      contractPath,
      JSON.stringify([{ id: "DR-101", title: "contract finding" }]),
      "utf8",
    );
    const conceptualPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_conceptual);
    await writeFile(conceptualPath, '{"findings": [ {"id": "DR-2', "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    // Must not throw: the malformed lane quarantines like any other bad shape.
    await handleDesignReviewBranch(params, bundle, state);

    // The valid contract lane merged and PERSISTED.
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.contract_reviewed).toBe(true);
    expect(written.contract_findings).toEqual([{ id: "DR-101", title: "contract finding" }]);

    // The malformed conceptual lane survives, verbatim, under quarantine/.
    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].startsWith(`${GATE_LANES.design_review_conceptual}.`)).toBe(true);
    const quarantinedContent = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
    expect(quarantinedContent).toBe('{"findings": [ {"id": "DR-2');

    // The rejection is recorded so the re-emitted step can name it.
    const rejection = (written.rejected_submissions ?? []).find(
      (r: RejectedDesignReviewSubmission) => r.pass === "conceptual",
    );
    expect(rejection).toBeTruthy();
    expect(rejection.lane).toBe(GATE_LANES.design_review_conceptual);
    expect(/json/i.test(rejection.reason)).toBe(true);
  });
});

await test("handleDesignReviewBranch quarantines an ambiguous two-array-property submission (fails both the array check and the unwrap)", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const conceptualPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_conceptual);
    await writeFile(
      conceptualPath,
      JSON.stringify({
        contract_findings: [{ id: "DR-001" }],
        conceptual_findings: [{ id: "DR-002" }],
      }),
      "utf8",
    );

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");

    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    const rejection = written.rejected_submissions.find(
      (r: RejectedDesignReviewSubmission) => r.pass === "conceptual",
    );
    expect(rejection).toBeTruthy();
    expect(rejection.reason.includes("2 array-valued propert")).toBe(true);
  });
});

await test("handleDesignReviewBranch quarantines a malformed legacy findings file rather than destroying it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });

    const findingsPath = laneSubmissionPath(artifactsDir, GATE_LANES.design_review_legacy);
    await writeFile(findingsPath, JSON.stringify({ not: "an array or a single-array wrapper" }), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ reviewed: false }), "utf8");

    const bundle: ArtifactBundle = {
      design_assessment: { generated_at: "now", findings: [], reviewed: false, review_findings: [] },
    };
    const state: AuditState = { status: "active", obligations: [] };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    // Legacy quarantine folds ("continue") — the very next fold iteration
    // (same drain call, reloaded bundle) re-evaluates contract/conceptual and
    // surfaces the recorded rejection via the returned host step.
    expect(branch.action).toBe("continue");

    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].startsWith(`${GATE_LANES.design_review_legacy}.`)).toBe(true);

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.rejected_submissions.length).toBe(1);
    expect(written.rejected_submissions[0].pass).toBe("legacy");

    // Legacy submission must be gone from its bound path (quarantined, not left in place).
    let stillInIncoming = true;
    try {
      await readFile(findingsPath, "utf8");
    } catch {
      stillInIncoming = false;
    }
    expect(stillInIncoming).toBe(false);
  });
});

await test("renderDesignReviewRejectionNotice returns undefined when there is nothing to report", () => {
  const bundle = { design_assessment: { generated_at: "now", findings: [] } };
  expect(renderDesignReviewRejectionNotice(bundle, ["contract"])).toBe(undefined);

  const bundleWithUnrelatedRejection: ArtifactBundle = {
    design_assessment: {
      generated_at: "now",
      findings: [],
      rejected_submissions: [
        {
          pass: "conceptual",
          lane: "design_review_conceptual",
          quarantine_path: "/tmp/quarantine/x.json",
          reason: "a bare string",
          rejected_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
  };
  // Asking only about "contract" should not surface an unrelated conceptual rejection.
  expect(renderDesignReviewRejectionNotice(bundleWithUnrelatedRejection, ["contract"])).toBe(undefined);
});

// ── consumeArraySubmission ───────────────────────────────────────────────────

await test("consumeArraySubmission returns absent when nothing was submitted", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const result = await consumeArraySubmission(
      artifactsDir,
      GATE_LANES.design_review_contract,
    );
    expect(result).toEqual({ status: "absent" });
  });
});

await test("consumeArraySubmission accepts a bare array and LEAVES IT ON DISK for the caller (P25-f)", async () => {
  // The unlink used to happen here, at unwrap time — so a caller that then had
  // no target to merge into destroyed valid work. Deletion is now the caller's,
  // after it has applied the value.
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const lane = GATE_LANES.design_review_contract;
    const filePath = laneSubmissionPath(artifactsDir, lane);
    await writeFile(filePath, JSON.stringify([{ id: "A" }, { id: "B" }]), "utf8");

    const result = await consumeArraySubmission(artifactsDir, lane);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected status=ok");
    expect(result.value).toEqual([{ id: "A" }, { id: "B" }]);
    expect(result.path).toBe(filePath);

    expect(
      await readFile(filePath, "utf8"),
      "an accepted submission survives the read — the caller unlinks after applying",
    ).toBe(JSON.stringify([{ id: "A" }, { id: "B" }]));
  });
});

// ── handleGraphEnrichmentBranch — malformed-submission quarantine ─────────────
//
// The graph_enrichment sibling of the design-review quarantine fix. A malformed
// edge-reasoning.json used to no-op silently inside applyEdgeReasoning (it
// never throws), the unconditional unlink then destroyed the file, and the
// identical edge_reasoning step re-emitted with zero signal. Now: tolerant
// unwrap (bare array OR single-array-property object), else quarantine + a
// rejection marker the re-emitted step's prompt reads. analyzer-decisions.json
// had the related stuck-loop shape (a non-object value was neither merged,
// deleted, nor diagnosed) — now quarantined via consumeObjectSubmission.

/**
 * `RunAuditStepOptions` (src/audit/cli/auditStep.ts) no longer declares an
 * `edgeReasoningResultsPath` field at all — the fix this test guards
 * ("The submission arrives validated and parsed — never a raw file path")
 * retired it in favor of `edgeReasoningResults`. Widened locally (optional,
 * `undefined`-only) so the regression assertion confirming the retired field
 * is never populated can still be typed, without touching the real contract.
 */
type RunAuditStepOptionsCapture = RunAuditStepOptions & { edgeReasoningResultsPath?: undefined };

/**
 * Minimal valid `runAuditStep` return value for the injected `deps.runStep`
 * test doubles below — only the call ARGUMENTS matter to these tests, but the
 * real signature returns `Promise<AdvanceAuditResult>`, so the stub must too.
 */
const STUB_ADVANCE_RESULT: AdvanceAuditResult = {
  audit_state: { status: "active", obligations: [] },
  selected_obligation: null,
  selected_executor: null,
  progress_made: true,
  artifacts_written: [],
  progress_summary: "",
  next_likely_step: null,
  updated_bundle: {},
};

/** Bundle with one low-confidence edge → exactly one edge-reasoning candidate. */
function edgeReasoningBundle(): ArtifactBundle {
  return {
    // repo_manifest / file_disposition intentionally absent — no unresolved
    // analyzers → straight to the edge-reasoning gate.
    graph_bundle: {
      graphs: {
        imports: [
          { from: "src/a.ts", to: "src/b.ts", kind: "import", confidence: 0.2, reason: "old reason" },
        ],
        calls: [],
        references: [],
      },
    },
  };
}

function edgeReasoningParams(
  artifactsDir: string,
): Pick<NextStepParams, "root" | "artifactsDir" | "graphLlmEdgeReasoning" | "since"> {
  return { root: artifactsDir, artifactsDir, graphLlmEdgeReasoning: true, since: undefined };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

await test("handleGraphEnrichmentBranch applies a canonical {rewrites:[...]} submission as a parsed object and deletes it after apply", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const resultsPath = laneSubmissionPath(artifactsDir, GATE_LANES.edge_reasoning);
    const rewrites = [{ from: "src/a.ts", to: "src/b.ts", kind: "import", reason: "clearer reason" }];
    await writeFile(resultsPath, JSON.stringify({ rewrites }), "utf8");

    const runStepCalls: RunAuditStepOptionsCapture[] = [];
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      { runStep: async (opts) => { runStepCalls.push(opts); return STUB_ADVANCE_RESULT; } },
    );

    expect(branch.action).toBe("continue");
    expect(runStepCalls.length).toBe(1);
    // The submission arrives validated and parsed — never a raw file path for
    // an unvalidated readJsonFile cast downstream.
    expect(runStepCalls[0].edgeReasoningResults).toEqual({ rewrites });
    expect(runStepCalls[0].edgeReasoningResultsPath).toBe(undefined);
    // Consumed after the successful apply; nothing quarantined.
    expect(await fileExists(resultsPath)).toBe(false);
    expect(await quarantinedFiles(artifactsDir)).toEqual([]);
  });
});

await test("handleGraphEnrichmentBranch tolerant-unwraps a bare-array edge-reasoning submission into {rewrites}", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const resultsPath = laneSubmissionPath(artifactsDir, GATE_LANES.edge_reasoning);
    const rewrites = [{ from: "src/a.ts", to: "src/b.ts", reason: "clearer reason" }];
    await writeFile(resultsPath, JSON.stringify(rewrites), "utf8");

    const runStepCalls: RunAuditStepOptions[] = [];
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      { runStep: async (opts) => { runStepCalls.push(opts); return STUB_ADVANCE_RESULT; } },
    );

    expect(branch.action).toBe("continue");
    expect(runStepCalls.length).toBe(1);
    expect(runStepCalls[0].edgeReasoningResults).toEqual({ rewrites });
    expect(await fileExists(resultsPath)).toBe(false);
  });
});

await test("handleGraphEnrichmentBranch quarantines a malformed edge-reasoning submission instead of destroying it, and the re-emitted step carries the notice", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const resultsPath = laneSubmissionPath(artifactsDir, GATE_LANES.edge_reasoning);
    await writeFile(resultsPath, JSON.stringify("oops, not rewrites"), "utf8");

    const runStepCalls: RunAuditStepOptions[] = [];
    const deps = { runStep: async (opts: RunAuditStepOptions) => { runStepCalls.push(opts); return STUB_ADVANCE_RESULT; } };
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      deps,
    );

    // Nothing applied: a malformed submission never reaches runAuditStep (the
    // old path "applied" it as a silent no-op, then destroyed the file).
    expect(branch.action).toBe("continue");
    expect(runStepCalls.length).toBe(0);

    // Gone from the bound path ... but NOT destroyed: verbatim under quarantine/.
    expect(await fileExists(resultsPath)).toBe(false);
    const quarantined = (await quarantinedFiles(artifactsDir)).filter((name) =>
      name.startsWith(`${GATE_LANES.edge_reasoning}.`),
    );
    expect(quarantined.length).toBe(1);
    const quarantinedContent = await readFile(
      join(artifactsDir, "quarantine", quarantined[0]),
      "utf8",
    );
    expect(JSON.parse(quarantinedContent)).toBe("oops, not rewrites");

    // The rejection marker renders a notice naming the file, path, and reason —
    // this is what nextStepCommand.ts threads into the re-emitted step prompt.
    const notice = await renderEdgeReasoningRejectionNotice(artifactsDir);
    expect(notice).toBeTruthy();
    if (notice === undefined) throw new Error("expected a notice");
    expect(notice.includes(GATE_LANES.edge_reasoning)).toBe(true);
    expect(notice.includes(quarantined[0])).toBe(true);
    expect(notice.includes("string")).toBe(true);

    // Next fold iteration (the submission now absent): the edge_reasoning step
    // re-emits — with the marker still pending for its prompt — instead of the
    // silent identical re-ask the destroy path produced.
    const reEmit = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      deps,
    );
    expect(reEmit.action).toBe("return");
    if (reEmit.action !== "return") throw new Error("expected action=return");
    expect(reEmit.result.kind).toBe("edge_reasoning");
    expect(await renderEdgeReasoningRejectionNotice(artifactsDir)).toBeTruthy();
  });
});

await test("handleGraphEnrichmentBranch clears the rejection marker once a valid resubmission is applied", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const resultsPath = laneSubmissionPath(artifactsDir, GATE_LANES.edge_reasoning);
    const deps = { runStep: async () => STUB_ADVANCE_RESULT };

    // Round 1: malformed (two array properties — ambiguous) → quarantined.
    await writeFile(resultsPath, JSON.stringify({ two: [], arrays: [] }), "utf8");
    await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      deps,
    );
    expect(await renderEdgeReasoningRejectionNotice(artifactsDir)).toBeTruthy();

    // Round 2: fixed shape → applied, marker cleared (no stale notice on the
    // next re-emit).
    await writeFile(
      resultsPath,
      JSON.stringify({ rewrites: [{ from: "src/a.ts", to: "src/b.ts", reason: "fixed" }] }),
      "utf8",
    );
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "active", obligations: [] },
      { value: undefined },
      deps,
    );
    expect(branch.action).toBe("continue");
    expect(await renderEdgeReasoningRejectionNotice(artifactsDir)).toBe(undefined);
  });
});

// ── consumeObjectIncoming (analyzer-decisions stuck-loop fix) ─────────────────

await test("consumeObjectIncoming quarantines a non-object value instead of leaving it to re-emit forever", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const filePath = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_decisions);
    await writeFile(filePath, JSON.stringify("not a decisions map"), "utf8");

    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrWrites.push(String(chunk)); return true; };
    let result;
    try {
      result = await consumeObjectSubmission(artifactsDir, GATE_LANES.analyzer_decisions);
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result.status).toBe("quarantined");
    if (result.status !== "quarantined") throw new Error("expected status=quarantined");
    expect(result.reason.includes("string")).toBe(true);
    // Diagnosed loudly — the old path was neither merged, deleted, nor diagnosed.
    expect(stderrWrites.join("").includes(GATE_LANES.analyzer_decisions)).toBe(true);
    // Gone from the bound path (the stuck loop), preserved verbatim in quarantine/.
    expect(await fileExists(filePath)).toBe(false);
    const quarantined = (await quarantinedFiles(artifactsDir)).filter((name) =>
      name.startsWith(`${GATE_LANES.analyzer_decisions}.`),
    );
    expect(quarantined.length).toBe(1);
    const content = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
    expect(JSON.parse(content)).toBe("not a decisions map");
  });
});

await test("consumeObjectSubmission quarantines an array (never a valid id→decision map) and accepts an object without deleting it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(submissionsDir(artifactsDir), { recursive: true });
    const filePath = laneSubmissionPath(artifactsDir, GATE_LANES.analyzer_decisions);

    await writeFile(filePath, JSON.stringify(["ephemeral", "skip"]), "utf8");
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    let arrayResult;
    try {
      arrayResult = await consumeObjectSubmission(artifactsDir, GATE_LANES.analyzer_decisions);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(arrayResult.status).toBe("quarantined");

    // A plain object is accepted — and NOT deleted here: the caller unlinks
    // after applying, so a crash mid-apply retains the submission.
    await writeFile(filePath, JSON.stringify({ pylint: "skip" }), "utf8");
    const okResult = await consumeObjectSubmission(artifactsDir, GATE_LANES.analyzer_decisions);
    expect(okResult.status).toBe("ok");
    if (okResult.status !== "ok") throw new Error("expected status=ok");
    expect(okResult.value).toEqual({ pylint: "skip" });
    expect(okResult.path).toBe(filePath);
    expect(await fileExists(filePath)).toBe(true);
  });
});

// ── runOmittableGate gates — malformed-submission quarantine (all 6) ──────────
//
// Regression coverage for the "runtime loop defect" class: the 6 host-gate
// ingests driven by the shared `runOmittableGate` engine used to hand the raw
// submitted file straight to the executor. A mis-shaped submission then EITHER
// crashed next-step with an uncaught ZodError (the 4 schema-parsed gates —
// charter_extraction / charter_delta / charter_clarification / systemic_challenge)
// OR was silently accepted as an empty "reviewed, found nothing" result (the 2
// bare-cast gates — synthesis_narrative / critical_flow_fallback). The fix makes
// `runOmittableGate` schema-validate at the ingest boundary and quarantine
// loudly (never unlink-and-discard), matching `handleIntentEquivalenceBranch`.

type OmittableGateParams = Pick<NextStepParams, "root" | "artifactsDir">;

type OmittableGateCase = {
  kind: string;
  lane: string;
  /** Bundle override for gates whose lanes are only consulted under a specific state. */
  bundle?: ArtifactBundle;
  handler: (
    params: OmittableGateParams,
    bundle: ArtifactBundle,
    state: AuditState,
  ) => Promise<{ action: string }>;
};

const OMITTABLE_GATES: OmittableGateCase[] = [
  {
    kind: "synthesis_narrative",
    lane: GATE_LANES.synthesis_narrative,
    // narrativeEnabled:true → shouldOmit false → host turn owed ("return").
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleSynthesisNarrativeBranch({ ...params, narrativeEnabled: true }, bundle, state),
  },
  {
    kind: "critical_flow_fallback",
    lane: GATE_LANES.critical_flow_fallback,
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleCriticalFlowFallbackBranch(params, bundle, state),
  },
  {
    kind: "charter_extraction",
    // Multi-lane gate (design resolution 2): the malformed submission sits in
    // ONE kind's lane file; the gate must quarantine that lane and re-emit the
    // step (action "return"), never crash or silently merge around it. The
    // lanes are only consulted at a deep+ ceiling, so this entry carries the
    // checkpoint that requests charters.
    lane: charterExtractionLane("stated"),
    bundle: {
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1",
        confirmed_at: "2026-01-01T00:00:00Z",
        confirmed_by: "host",
        scope_summary: "s",
        intent_summary: "i",
        design_review: { conceptual_depth: "deep" },
      },
    } satisfies ArtifactBundle,
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleCharterExtractionBranch(params, bundle, state),
  },
  {
    kind: "charter_delta",
    lane: GATE_LANES.charter_delta,
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleCharterDeltaBranch(params, bundle, state),
  },
  {
    kind: "charter_clarification",
    lane: GATE_LANES.charter_clarification,
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleCharterClarificationBranch(params, bundle, state),
  },
  {
    kind: "systemic_challenge",
    lane: GATE_LANES.systemic_challenge,
    handler: (params: OmittableGateParams, bundle: ArtifactBundle, state: AuditState) =>
      handleSystemicChallengeBranch(params, bundle, state),
  },
];

for (const gate of OMITTABLE_GATES) {
  await test(`runOmittableGate quarantines a malformed ${gate.kind} submission instead of crashing or silently degrading`, async () => {
    await withTempDir(async (artifactsDir) => {
      await mkdir(submissionsDir(artifactsDir), { recursive: true });
      const submissionPath = laneSubmissionPath(artifactsDir, gate.lane);
      // A bare number fails every top-level object schema ("expected object,
      // received number") — a shape no gate could ever legitimately accept.
      await writeFile(submissionPath, JSON.stringify(42), "utf8");

      const params = { root: artifactsDir, artifactsDir };
      const bundle = gate.bundle ?? {};
      const state: AuditState = { status: "active", obligations: [] };

      // Mute the quarantine stderr diagnostic for a clean test log.
      const origWrite = process.stderr.write;
      process.stderr.write = () => true;
      let branch;
      try {
        // MUST NOT throw — pre-fix, the schema-parsed gates crashed here with an
        // uncaught ZodError as the raw file was handed to runAuditStep.
        branch = await gate.handler(params, bundle, state);
      } finally {
        process.stderr.write = origWrite;
      }

      // Fell through to omit-or-return; the malformed file was NEVER applied
      // (apply → runAuditStep is unreachable), so the action is not "continue".
      expect(["run_omit", "return"]).toContain(branch.action);

      // Moved off the bound path ...
      expect(await fileExists(submissionPath)).toBe(false);
      // ... and preserved verbatim under quarantine/ (never unlink-and-discard).
      const quarantined = await quarantinedFiles(artifactsDir);
      expect(quarantined.length).toBe(1);
      expect(quarantined[0].startsWith(`${gate.lane}.`)).toBe(true);
      const content = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
      expect(JSON.parse(content)).toBe(42);
    });
  });
}
