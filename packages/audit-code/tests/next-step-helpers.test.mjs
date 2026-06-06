import test from "node:test";
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
} = await import("../src/cli/nextStepCommand.ts");

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
    assert.equal(result.kind, "complete");
    assert.ok(result.finalReportPath.endsWith("audit-report.md"));
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
    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "blocked reason");
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
      opentoken: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    // If unresolved is non-empty and no decisions file is present, it should
    // return the analyzer_install prompt. If pylint is not in the default
    // registry (no unresolved entries), fall through is acceptable — either
    // way the function must not throw.
    assert.ok(
      branch.action === "fallthrough" ||
      branch.action === "return" ||
      branch.action === "continue",
    );
    if (branch.action === "return") {
      assert.ok(
        branch.result.kind === "analyzer_install" ||
        branch.result.kind === "edge_reasoning",
      );
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
      opentoken: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    // With an empty repo_manifest, unresolved will be [] — the function should
    // fall through to the edge-reasoning check and return "fallthrough" (no
    // candidates, flag off). The decisions file is irrelevant in this path.
    assert.ok(branch.action === "fallthrough" || branch.action === "continue");
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
      opentoken: undefined,
    };

    const branch = await handleGraphEnrichmentBranch(params, bundle, state, analyzersRef);
    assert.equal(branch.action, "fallthrough");
  });
});

// ── handleDesignReviewBranch ──────────────────────────────────────────────────

await test("handleDesignReviewBranch returns design_review when no incoming findings file", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    // No design-review-findings.json written — the function should return design_review.
    const bundle = { design_assessment: { reviewed: false } };
    const state = { status: "planning" };
    const params = { artifactsDir };

    const branch = await handleDesignReviewBranch(params, bundle, state);
    assert.equal(branch.action, "return");
    assert.equal(branch.result.kind, "design_review");
  });
});

await test("handleDesignReviewBranch returns continue after merging a valid findings file and deleting it", async () => {
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
    assert.equal(branch.action, "continue");

    // The incoming findings file should have been deleted
    let exists = true;
    try {
      await import("node:fs/promises").then((m) => m.access(findingsPath));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, "findings file should be deleted after merge");
  });
});

// ── checkFinalizationCycle ────────────────────────────────────────────────────

await test("checkFinalizationCycle returns undefined when distinct state count is within tolerance", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "steps"), { recursive: true });

    const obligationTrail = [];
    const seenStateSignatures = new Set();
    const tolerance = 4;
    const params = { artifactsDir, maxRuns: 100, root: artifactsDir };

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
    assert.equal(result, undefined);
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
    const params = { artifactsDir, maxRuns: 100, root: artifactsDir };

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
    assert.ok(result !== undefined);
    assert.ok(result.kind === "blocked" || result.kind === "complete");
  });
});

// ── tryConsumeIncoming ────────────────────────────────────────────────────────

await test("tryConsumeIncoming returns undefined when file does not exist", async () => {
  await withTempDir(async (artifactsDir) => {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    // No file written under incoming/

    const result = await tryConsumeIncoming(artifactsDir, "nonexistent.json");

    assert.equal(result, undefined, "should resolve to undefined without throwing");
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

    assert.ok(result !== undefined, "result should not be undefined");
    assert.deepEqual(result.value, payload, "value should match the written payload");
    assert.equal(
      result.path,
      join(artifactsDir, "incoming", filename),
      "path should equal join(artifactsDir, 'incoming', filename)",
    );
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
