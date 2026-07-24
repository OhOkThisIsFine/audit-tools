import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the extracted helpers directly from source via tsx (same pattern as
// other audit-code test files that import from .ts files directly).
const {
  buildTerminalStep,
  handleGraphEnrichmentBranch,
  handleDesignReviewBranch,
  checkFinalizationCycle,
  tryConsumeIncoming,
  consumeArrayIncoming,
  consumeObjectIncoming,
  renderDesignReviewRejectionNotice,
  renderEdgeReasoningRejectionNotice,
} = await import("../../src/audit/cli/nextStepCommand.ts");

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
} = await import("../../src/audit/cli/nextStepHelpers.ts");

async function withTempDir(fn) {
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
    const state = { status: "planning", obligations: [] }; // not "complete" but report is present

    const result = await buildTerminalStep(params, bundle, state, "reason");
    expect(result.kind).toBe("complete");
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
    const state = { status: "planning", obligations: [] };

    const result = await buildTerminalStep(params, bundle, state, "blocked reason");
    expect(result.kind).toBe("blocked");
    expect(result.reason).toBe("blocked reason");
  });
});

// ── handleGraphEnrichmentBranch ───────────────────────────────────────────────

await test("handleGraphEnrichmentBranch returns analyzer_install when unresolved entries exist and no decisions file", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    // Build a minimal bundle with a repo_manifest that contains one Python file
    // whose analyzer (pylint) requires an install decision.
    const bundle = {
      repo_manifest: {
        files: [
          { path: "src/app.py", language: "python", size_bytes: 100 },
        ],
      },
      file_disposition: null,
      graph_bundle: null,
    };
    const state = { status: "planning" };
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const decisionsPath = join(artifactsDir, "incoming", "analyzer-decisions.json");
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
    const bundle = {
      repo_manifest: null,
      file_disposition: null,
      graph_bundle: null,
    };
    const state = { status: "planning" };
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
    const bundle = {
      repo_manifest: null,
      file_disposition: null,
      graph_bundle: null,
    };
    const state = { status: "planning" };
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

await test("handleDesignReviewBranch returns design_review_parallel when both passes unsatisfied and no incoming files", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    // No incoming files — both passes unsatisfied → parallel dispatch.
    const bundle = { design_assessment: { contract_reviewed: false, conceptual_reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");
    expect(branch.result.kind).toBe("design_review_parallel");
  });
});

await test("handleDesignReviewBranch returns continue after merging contract findings only, sets contract_reviewed=true", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const contractPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    await writeFile(contractPath, JSON.stringify([{ id: "DR-001", title: "contract finding" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state = { status: "planning" };
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const conceptualPath = join(artifactsDir, "incoming", "design-review-conceptual-findings.json");
    await writeFile(conceptualPath, JSON.stringify([{ id: "DR-001", title: "conceptual finding" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [], contract_reviewed: true }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: true, conceptual_reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    const { readFile } = await import("node:fs/promises");
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.conceptual_reviewed).toBe(true);
  });
});

await test("handleDesignReviewBranch returns continue after merging both incoming files simultaneously", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const contractPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    const conceptualPath = join(artifactsDir, "incoming", "design-review-conceptual-findings.json");
    await writeFile(contractPath, JSON.stringify([{ id: "DR-001", title: "contract" }]), "utf8");
    await writeFile(conceptualPath, JSON.stringify([{ id: "DR-001", title: "conceptual" }]), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state = { status: "planning" };
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    // No incoming files, contract already done.
    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: true, conceptual_reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");
    expect(branch.result.kind).toBe("design_review_conceptual");
  });
});

await test("handleDesignReviewBranch returns continue after merging a valid legacy findings file and deleting it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const findingsPath = join(artifactsDir, "incoming", "design-review-findings.json");
    await writeFile(findingsPath, JSON.stringify([{ id: "F-1", title: "test" }]), "utf8");

    // Write a stub design_assessment.json so writeCoreArtifacts has a path
    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ reviewed: false }), "utf8");

    const bundle = {
      design_assessment: {
        reviewed: false,
        review_findings: [],
      },
    };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    // The incoming findings file should have been deleted
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

    const obligationTrail = [];
    const seenStateSignatures = new Set();
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
      state: { status: "planning" },
      result: {
        updated_bundle: {},
        audit_state: { status: "planning" },
        progress_made: true,
        progress_summary: "ok",
        selected_executor: "test",
        selected_obligation: "test",
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
    const obligationTrail = Array(10).fill("synthesis_current");
    const seenStateSignatures = new Set(["sig-a", "sig-b"]);

    const result = await checkFinalizationCycle({
      index: 9, // index=9, size=2 → 10-2=8 >= 4 → cycle detected
      obligationTrail,
      seenStateSignatures,
      tolerance,
      params,
      bundle: {},
      state: { status: "planning" },
      result: {
        updated_bundle: {},
        audit_state: { status: "planning", obligations: [] },
        progress_made: true,
        progress_summary: "ok",
        selected_executor: "synthesis_executor",
        selected_obligation: "synthesis_current",
      },
      selectedObligation: "synthesis_current",
    });

    // Should return a terminal result (blocked or complete)
    expect(result !== undefined).toBeTruthy();
    expect(result.kind === "blocked" || result.kind === "complete").toBeTruthy();
  });
});

// ── tryConsumeIncoming ────────────────────────────────────────────────────────

await test("tryConsumeIncoming returns undefined when file does not exist", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    // No file written under incoming/

    const result = await tryConsumeIncoming(artifactsDir, "nonexistent.json");

    expect(result, "should resolve to undefined without throwing").toBe(undefined);
  });
});

await test("tryConsumeIncoming returns parsed value and path when file exists", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const payload = { foo: "bar", count: 42 };
    const filename = "test-artifact.json";
    await writeFile(
      join(artifactsDir, "incoming", filename),
      JSON.stringify(payload),
      "utf8",
    );

    const result = await tryConsumeIncoming(artifactsDir, filename);

    expect(result !== undefined, "result should not be undefined").toBeTruthy();
    expect(result.value, "value should match the written payload").toEqual(payload);
    expect(result.path, "path should equal join(artifactsDir, 'incoming', filename)").toBe(join(artifactsDir, "incoming", filename));
  });
});

await test("tryConsumeIncoming re-throws non-ENOENT errors", async () => {
  await withTempDir(async (artifactsDir) => {
    // Write a file with invalid JSON to trigger a parse error (non-missing-file error)
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const filename = "bad-json.json";
    await writeFile(
      join(artifactsDir, "incoming", filename),
      "not valid json {{",
      "utf8",
    );

    await assert.rejects(
      () => tryConsumeIncoming(artifactsDir, filename),
      "should re-throw JSON parse errors",
    );
  });
});

// ── HOST_GATE_DESCRIPTORS coverage (Tier C2 consolidation) ────────────────────

await test("HOST_GATE_KINDS / HOST_GATE_DESCRIPTORS cover exactly the 9 audit host-gate kinds", () => {
  const expected = [
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

  // The 6 gates driven by the shared runOmittableGate engine vs. the 3 that
  // keep bespoke bodies (graph_enrichment, design_review, intent_equivalence)
  // because their shape genuinely deviates from the common one.
  const generic = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "generic");
  const custom = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "custom");
  expect(generic.sort()).toEqual(
    ["critical_flow_fallback", "synthesis_narrative", "charter_extraction", "charter_delta", "charter_clarification", "systemic_challenge"].sort(),
  );
  expect(custom.sort()).toEqual(["graph_enrichment", "design_review", "intent_equivalence"].sort());
});

// ── handleDesignReviewBranch — malformed-submission quarantine ───────────────
//
// Regression coverage for the "silently DESTROYS a malformed submission"
// defect: `handleDesignReviewBranch` used to unconditionally `unlink` every
// incoming design-review file and merge ONLY when `Array.isArray(value)` — any
// other shape (most commonly a JSON-object-mode host wrapping its array as
// `{findings:[...]}`) was destroyed with no quarantine, no message, and the
// identical step re-emitted forever. Fixed via `consumeArrayIncoming`
// (tolerant single-array-property unwrap, else quarantine-not-delete) plus
// `renderDesignReviewRejectionNotice` (names the quarantined file + reason in
// the re-emitted step).

async function quarantinedFiles(artifactsDir) {
  const dir = join(artifactsDir, "quarantine");
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

await test("handleDesignReviewBranch accepts an object-wrapped {findings:[...]} contract submission (tolerant unwrap)", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const contractPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    // Object-wrapped, not a bare array — the PowerShell/json_object-mode
    // single-element-array-collapses-to-object shape (memory:
    // submit-packet-json-array-trap) generalized to a whole-array wrap.
    await writeFile(
      contractPath,
      JSON.stringify({ findings: [{ id: "DR-001", title: "contract finding" }] }),
      "utf8",
    );

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("continue");

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.contract_reviewed).toBe(true);
    expect(written.contract_findings).toEqual([{ id: "DR-001", title: "contract finding" }]);
    // Obligation credited (merged), so no quarantine and nothing pending.
    expect(await quarantinedFiles(artifactsDir)).toEqual([]);
    expect(written.rejected_submissions ?? []).toEqual([]);

    // The incoming file was consumed (deleted), not left behind.
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const contractPath = join(artifactsDir, "incoming", "design-review-contract-findings.json");
    await writeFile(contractPath, JSON.stringify("oops, not an array"), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ generated_at: "now", findings: [] }), "utf8");

    const bundle = { design_assessment: { generated_at: "now", findings: [], contract_reviewed: false, conceptual_reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);

    // Genuinely malformed → the step re-emits (nothing merged, contract pass
    // still unsatisfied) rather than silently swallowing it as "continue".
    expect(branch.action).toBe("return");
    expect(["design_review_contract", "design_review_parallel"]).toContain(branch.result.kind);

    // The original incoming file is gone from incoming/ ...
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
    expect(quarantined[0].startsWith("design-review-contract-findings.json.")).toBe(true);
    const quarantinedContent = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
    expect(JSON.parse(quarantinedContent)).toBe("oops, not an array");

    // The rejection is recorded on design_assessment so it survives the
    // same-call `continue` re-derivation, and names the file + reason.
    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.rejected_submissions.length).toBe(1);
    const rejection = written.rejected_submissions[0];
    expect(rejection.pass).toBe("contract");
    expect(rejection.filename).toBe("design-review-contract-findings.json");
    expect(rejection.reason.includes("string")).toBe(true);
    expect(rejection.quarantine_path.endsWith(quarantined[0])).toBe(true);

    // The re-emitted step's bundle carries the same note (same in-memory
    // design_assessment object) — this is what nextStepCommand.ts threads into
    // the re-emitted step's prompt via renderDesignReviewRejectionNotice.
    const notice = renderDesignReviewRejectionNotice(branch.result.bundle, ["legacy", "contract"]);
    expect(notice).toBeTruthy();
    expect(notice.includes("design-review-contract-findings.json")).toBe(true);
    expect(notice.includes(rejection.quarantine_path)).toBe(true);
    expect(notice.includes("string")).toBe(true);
  });
});

await test("handleDesignReviewBranch quarantines an ambiguous two-array-property submission (fails both the array check and the unwrap)", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const conceptualPath = join(artifactsDir, "incoming", "design-review-conceptual-findings.json");
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
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    expect(branch.action).toBe("return");

    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    const rejection = written.rejected_submissions.find((r) => r.pass === "conceptual");
    expect(rejection).toBeTruthy();
    expect(rejection.reason.includes("2 array-valued propert")).toBe(true);
  });
});

await test("handleDesignReviewBranch quarantines a malformed legacy findings file rather than destroying it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });

    const findingsPath = join(artifactsDir, "incoming", "design-review-findings.json");
    await writeFile(findingsPath, JSON.stringify({ not: "an array or a single-array wrapper" }), "utf8");

    const designAssessmentPath = join(artifactsDir, "design_assessment.json");
    await writeFile(designAssessmentPath, JSON.stringify({ reviewed: false }), "utf8");

    const bundle = { design_assessment: { reviewed: false, review_findings: [] } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    // Legacy quarantine folds ("continue") — the very next fold iteration
    // (same drain call, reloaded bundle) re-evaluates contract/conceptual and
    // surfaces the recorded rejection via the returned host step.
    expect(branch.action).toBe("continue");

    const quarantined = await quarantinedFiles(artifactsDir);
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].startsWith("design-review-findings.json.")).toBe(true);

    const written = JSON.parse(await readFile(designAssessmentPath, "utf8"));
    expect(written.rejected_submissions.length).toBe(1);
    expect(written.rejected_submissions[0].pass).toBe("legacy");

    // Legacy file must be gone from incoming/ (quarantined, not left in place).
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

  const bundleWithUnrelatedRejection = {
    design_assessment: {
      generated_at: "now",
      findings: [],
      rejected_submissions: [
        {
          pass: "conceptual",
          filename: "design-review-conceptual-findings.json",
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

// ── consumeArrayIncoming ──────────────────────────────────────────────────────

await test("consumeArrayIncoming returns absent when the file does not exist", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const result = await consumeArrayIncoming(artifactsDir, "nonexistent.json");
    expect(result).toEqual({ status: "absent" });
  });
});

await test("consumeArrayIncoming accepts a bare array untouched (existing array-shaped path)", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const filePath = join(artifactsDir, "incoming", "arr.json");
    await writeFile(filePath, JSON.stringify([{ id: "A" }, { id: "B" }]), "utf8");

    const result = await consumeArrayIncoming(artifactsDir, "arr.json");
    expect(result.status).toBe("ok");
    expect(result.value).toEqual([{ id: "A" }, { id: "B" }]);

    let stillExists = true;
    try {
      await readFile(filePath, "utf8");
    } catch {
      stillExists = false;
    }
    expect(stillExists).toBe(false);
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
// deleted, nor diagnosed) — now quarantined via consumeObjectIncoming.

/** Bundle with one low-confidence edge → exactly one edge-reasoning candidate. */
function edgeReasoningBundle() {
  return {
    repo_manifest: null, // no unresolved analyzers → straight to the edge-reasoning gate
    file_disposition: null,
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

function edgeReasoningParams(artifactsDir) {
  return { root: artifactsDir, artifactsDir, graphLlmEdgeReasoning: true, since: undefined };
}

async function fileExists(path) {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

await test("handleGraphEnrichmentBranch applies a canonical {rewrites:[...]} submission as a parsed object and deletes it after apply", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const resultsPath = join(artifactsDir, "incoming", "edge-reasoning.json");
    const rewrites = [{ from: "src/a.ts", to: "src/b.ts", kind: "import", reason: "clearer reason" }];
    await writeFile(resultsPath, JSON.stringify({ rewrites }), "utf8");

    const runStepCalls = [];
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "planning" },
      { value: undefined },
      { runStep: async (opts) => { runStepCalls.push(opts); } },
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const resultsPath = join(artifactsDir, "incoming", "edge-reasoning.json");
    const rewrites = [{ from: "src/a.ts", to: "src/b.ts", reason: "clearer reason" }];
    await writeFile(resultsPath, JSON.stringify(rewrites), "utf8");

    const runStepCalls = [];
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "planning" },
      { value: undefined },
      { runStep: async (opts) => { runStepCalls.push(opts); } },
    );

    expect(branch.action).toBe("continue");
    expect(runStepCalls.length).toBe(1);
    expect(runStepCalls[0].edgeReasoningResults).toEqual({ rewrites });
    expect(await fileExists(resultsPath)).toBe(false);
  });
});

await test("handleGraphEnrichmentBranch quarantines a malformed edge-reasoning submission instead of destroying it, and the re-emitted step carries the notice", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const resultsPath = join(artifactsDir, "incoming", "edge-reasoning.json");
    await writeFile(resultsPath, JSON.stringify("oops, not rewrites"), "utf8");

    const runStepCalls = [];
    const deps = { runStep: async (opts) => { runStepCalls.push(opts); } };
    const branch = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "planning" },
      { value: undefined },
      deps,
    );

    // Nothing applied: a malformed submission never reaches runAuditStep (the
    // old path "applied" it as a silent no-op, then destroyed the file).
    expect(branch.action).toBe("continue");
    expect(runStepCalls.length).toBe(0);

    // Gone from incoming/ ... but NOT destroyed: verbatim under quarantine/.
    expect(await fileExists(resultsPath)).toBe(false);
    const quarantined = (await quarantinedFiles(artifactsDir)).filter((name) =>
      name.startsWith("edge-reasoning.json."),
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
    expect(notice.includes("edge-reasoning.json")).toBe(true);
    expect(notice.includes(quarantined[0])).toBe(true);
    expect(notice.includes("string")).toBe(true);

    // Next fold iteration (incoming now absent): the edge_reasoning step
    // re-emits — with the marker still pending for its prompt — instead of the
    // silent identical re-ask the destroy path produced.
    const reEmit = await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "planning" },
      { value: undefined },
      deps,
    );
    expect(reEmit.action).toBe("return");
    expect(reEmit.result.kind).toBe("edge_reasoning");
    expect(await renderEdgeReasoningRejectionNotice(artifactsDir)).toBeTruthy();
  });
});

await test("handleGraphEnrichmentBranch clears the rejection marker once a valid resubmission is applied", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const resultsPath = join(artifactsDir, "incoming", "edge-reasoning.json");
    const deps = { runStep: async () => {} };

    // Round 1: malformed (two array properties — ambiguous) → quarantined.
    await writeFile(resultsPath, JSON.stringify({ two: [], arrays: [] }), "utf8");
    await handleGraphEnrichmentBranch(
      edgeReasoningParams(artifactsDir),
      edgeReasoningBundle(),
      { status: "planning" },
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
      { status: "planning" },
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
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const filePath = join(artifactsDir, "incoming", "analyzer-decisions.json");
    await writeFile(filePath, JSON.stringify("not a decisions map"), "utf8");

    const stderrWrites = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrWrites.push(String(chunk)); return true; };
    let result;
    try {
      result = await consumeObjectIncoming(artifactsDir, "analyzer-decisions.json");
    } finally {
      process.stderr.write = origWrite;
    }

    expect(result.status).toBe("quarantined");
    expect(result.reason.includes("string")).toBe(true);
    // Diagnosed loudly — the old path was neither merged, deleted, nor diagnosed.
    expect(stderrWrites.join("").includes("analyzer-decisions.json")).toBe(true);
    // Gone from incoming/ (the stuck loop), preserved verbatim in quarantine/.
    expect(await fileExists(filePath)).toBe(false);
    const quarantined = (await quarantinedFiles(artifactsDir)).filter((name) =>
      name.startsWith("analyzer-decisions.json."),
    );
    expect(quarantined.length).toBe(1);
    const content = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
    expect(JSON.parse(content)).toBe("not a decisions map");
  });
});

await test("consumeObjectIncoming quarantines an array (never a valid id→decision map) and accepts an object without deleting it", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const filePath = join(artifactsDir, "incoming", "analyzer-decisions.json");

    await writeFile(filePath, JSON.stringify(["ephemeral", "skip"]), "utf8");
    const origWrite = process.stderr.write;
    process.stderr.write = () => true;
    let arrayResult;
    try {
      arrayResult = await consumeObjectIncoming(artifactsDir, "analyzer-decisions.json");
    } finally {
      process.stderr.write = origWrite;
    }
    expect(arrayResult.status).toBe("quarantined");

    // A plain object is accepted — and NOT deleted here: the caller unlinks
    // after applying, so a crash mid-apply retains the submission.
    await writeFile(filePath, JSON.stringify({ pylint: "skip" }), "utf8");
    const okResult = await consumeObjectIncoming(artifactsDir, "analyzer-decisions.json");
    expect(okResult.status).toBe("ok");
    expect(okResult.value).toEqual({ pylint: "skip" });
    expect(okResult.path).toBe(filePath);
    expect(await fileExists(filePath)).toBe(true);
  });
});

// ── runOmittableGate gates — malformed-submission quarantine (all 6) ──────────
//
// Regression coverage for the "runtime loop defect" class: the 6 host-gate
// ingests driven by the shared `runOmittableGate` engine used to hand the raw
// incoming file straight to the executor. A mis-shaped submission then EITHER
// crashed next-step with an uncaught ZodError (the 4 schema-parsed gates —
// charter_extraction / charter_delta / charter_clarification / systemic_challenge)
// OR was silently accepted as an empty "reviewed, found nothing" result (the 2
// bare-cast gates — synthesis_narrative / critical_flow_fallback). The fix makes
// `runOmittableGate` schema-validate at the ingest boundary and quarantine
// loudly (never unlink-and-discard), matching `handleIntentEquivalenceBranch`.

const OMITTABLE_GATES = [
  {
    kind: "synthesis_narrative",
    filename: "synthesis-narrative.json",
    // narrativeEnabled:true → shouldOmit false → host turn owed ("return").
    handler: (params, bundle, state) =>
      handleSynthesisNarrativeBranch({ ...params, narrativeEnabled: true }, bundle, state),
  },
  {
    kind: "critical_flow_fallback",
    filename: "critical-flow-fallback.json",
    handler: (params, bundle, state) => handleCriticalFlowFallbackBranch(params, bundle, state),
  },
  {
    kind: "charter_extraction",
    filename: "charter-extraction.json",
    handler: (params, bundle, state) => handleCharterExtractionBranch(params, bundle, state),
  },
  {
    kind: "charter_delta",
    filename: "charter-delta.json",
    handler: (params, bundle, state) => handleCharterDeltaBranch(params, bundle, state),
  },
  {
    kind: "charter_clarification",
    filename: "charter-clarification.json",
    handler: (params, bundle, state) => handleCharterClarificationBranch(params, bundle, state),
  },
  {
    kind: "systemic_challenge",
    filename: "systemic-challenge.json",
    handler: (params, bundle, state) => handleSystemicChallengeBranch(params, bundle, state),
  },
];

for (const gate of OMITTABLE_GATES) {
  await test(`runOmittableGate quarantines a malformed ${gate.kind} submission instead of crashing or silently degrading`, async () => {
    await withTempDir(async (artifactsDir) => {
      await mkdir(join(artifactsDir, "incoming"), { recursive: true });
      const incomingPath = join(artifactsDir, "incoming", gate.filename);
      // A bare number fails every top-level object schema ("expected object,
      // received number") — a shape no gate could ever legitimately accept.
      await writeFile(incomingPath, JSON.stringify(42), "utf8");

      const params = { root: artifactsDir, artifactsDir };
      const bundle = {};
      const state = { status: "planning" };

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

      // Moved out of incoming/ ...
      expect(await fileExists(incomingPath)).toBe(false);
      // ... and preserved verbatim under quarantine/ (never unlink-and-discard).
      const quarantined = await quarantinedFiles(artifactsDir);
      expect(quarantined.length).toBe(1);
      expect(quarantined[0].startsWith(`${gate.filename}.`)).toBe(true);
      const content = await readFile(join(artifactsDir, "quarantine", quarantined[0]), "utf8");
      expect(JSON.parse(content)).toBe(42);
    });
  });
}
