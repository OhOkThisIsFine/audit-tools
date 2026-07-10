import { test, expect, describe } from "vitest";

const {
  runCharterExtractionExecutor,
  resolveCharterCeiling,
  ceilingRequestsCharters,
} = await import("../../src/audit/orchestrator/charterExtractionExecutor.ts");

const { renderCharterExtractionPrompt } = await import(
  "../../src/audit/cli/charterExtractionPrompt.ts"
);

function bundleWith(overrides = {}) {
  return {
    repo_manifest: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 2,
      source_ids: ["call_import"],
      consensus: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts", "src/b.ts"],
          agreed_across_source: 1,
          stable_across_scale: 1,
          contested: false,
        },
      ],
      contested: [],
      findings: [],
    },
    ...overrides,
  };
}

function checkpoint(rung) {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "s",
    intent_summary: "i",
    design_review: rung ? { ceiling: { rung } } : {},
  };
}

describe("resolveCharterCeiling / ceilingRequestsCharters", () => {
  test("defaults to shallow when no checkpoint / no design_review", () => {
    expect(resolveCharterCeiling(undefined)).toEqual({ rung: "shallow" });
    expect(ceilingRequestsCharters({ rung: "shallow" })).toBe(false);
    expect(ceilingRequestsCharters({ rung: "deep" })).toBe(true);
    expect(ceilingRequestsCharters({ rung: "deepest" })).toBe(true);
  });

  test("legacy conceptual_depth:deep maps to a deep ceiling", () => {
    const cp = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { conceptual_depth: "deep" },
    };
    expect(resolveCharterCeiling(cp)).toEqual({ rung: "deep" });
  });
});

describe("renderCharterExtractionPrompt — ceiling-aware charter count", () => {
  const opts = (rung) => ({
    submissionPath: "/tmp/charter-extraction.json",
    continueCommand: "node audit-code.mjs next-step",
    ceiling: { rung },
  });

  test("deep ceiling asks for THREE charters (True is not nominatable)", () => {
    const prompt = renderCharterExtractionPrompt(bundleWith(), opts("deep"));
    expect(prompt).toContain("state up to **three charters**");
    expect(prompt).toContain("). The three:");
    expect(prompt).not.toContain("four charters");
    // The True bullet must still say "do not nominate one" at deep.
    expect(prompt).toContain("do not nominate one");
  });

  test("deepest ceiling asks for FOUR charters (True nominatable)", () => {
    const prompt = renderCharterExtractionPrompt(bundleWith(), opts("deepest"));
    expect(prompt).toContain("state up to **four charters**");
    expect(prompt).toContain("). The four:");
    expect(prompt).not.toContain("three charters");
    expect(prompt).toContain("shining city");
  });
});

describe("runCharterExtractionExecutor — omit path", () => {
  test("shallow ceiling writes an omitted register with no host turn", () => {
    const run = runCharterExtractionExecutor(bundleWith({ intent_checkpoint: checkpoint() }), undefined);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
    const reg = run.updated.charter_register;
    expect(reg.status).toBe("omitted");
    expect(reg.subsystems).toHaveLength(0);
    expect(reg.deltas).toHaveLength(0);
    expect(reg.ceiling).toEqual({ rung: "shallow" });
  });

  test("deep ceiling but no submission records an empty register", () => {
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      undefined,
    );
    expect(run.updated.charter_register.status).toBe("omitted");
    expect(run.progress_summary).toContain("no submission");
  });
});

describe("runCharterExtractionExecutor — ingest path", () => {
  test("assembles + gates a submission grounded against the consensus scaffold", () => {
    const submission = {
      subsystems: [
        {
          node_id: "src/a.ts",
          charters: [
            { kind: "stated", purpose: "exists so callers get audited output", provenance: [], confidence: "high" },
            { kind: "revealed", purpose: "optimizes for fast dispatch over coverage", provenance: [], confidence: "high" },
          ],
          deltas: [{ pair: ["stated", "revealed"], summary: "code favors speed over the stated coverage goal" }],
        },
        // An invented subsystem must be grounded out.
        { node_id: "ghost.ts", charters: [], deltas: [] },
      ],
      goal_graph: { nodes: [], edges: [] },
    };
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    const reg = run.updated.charter_register;
    expect(reg.status).toBeUndefined();
    expect(reg.subsystems.map((s) => s.node_id)).toEqual(["src/a.ts"]);
    expect(reg.deltas).toHaveLength(1);
    expect(reg.deltas[0].kind).toBe("spec_drift");
    expect(reg.deltas[0].routed_to).toBe("remediator");
    expect(reg.findings).toHaveLength(1);
    expect(reg.findings[0].category).toBe("charter_delta:spec_drift");
    expect(reg.validation_issues.join()).toContain("not a consensus node");
  });
});
