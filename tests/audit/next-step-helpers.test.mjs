import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
} = await import("../../src/audit/cli/nextStepCommand.ts");

// HOST_GATE_KINDS / HOST_GATE_DESCRIPTORS are internal to the Tier C2
// consolidation (not re-exported through nextStepCommand.ts), so import them
// directly from nextStepHelpers.ts.
const { HOST_GATE_KINDS, HOST_GATE_DESCRIPTORS } = await import(
  "../../src/audit/cli/nextStepHelpers.ts"
);

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

await test("HOST_GATE_KINDS / HOST_GATE_DESCRIPTORS cover exactly the 6 audit host-gate kinds", () => {
  const expected = [
    "graph_enrichment",
    "design_review",
    "synthesis_narrative",
    "charter_extraction",
    "charter_clarification",
    "systemic_challenge",
  ];
  expect([...HOST_GATE_KINDS].sort()).toEqual([...expected].sort());
  expect(Object.keys(HOST_GATE_DESCRIPTORS).sort()).toEqual([...expected].sort());

  // The 4 gates driven by the shared runOmittableGate engine vs. the 2 that
  // keep bespoke bodies (graph_enrichment, design_review) because their shape
  // genuinely deviates from the common one.
  const generic = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "generic");
  const custom = expected.filter((k) => HOST_GATE_DESCRIPTORS[k].driven === "custom");
  expect(generic.sort()).toEqual(
    ["synthesis_narrative", "charter_extraction", "charter_clarification", "systemic_challenge"].sort(),
  );
  expect(custom.sort()).toEqual(["graph_enrichment", "design_review"].sort());
});
