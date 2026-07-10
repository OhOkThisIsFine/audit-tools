import { test, expect, describe } from "vitest";

const { runCharterDeltaExecutor } = await import(
  "../../src/audit/orchestrator/charterDeltaExecutor.ts"
);

/** A charter as it appears in an ASSEMBLED register (charter_id already assigned). */
function charter(node_id, kind, confidence = "high") {
  return {
    charter_id: `${node_id}:${kind}`,
    kind,
    purpose: `telos of ${kind}`,
    provenance: [],
    confidence,
  };
}

/** A bundle carrying an assembled, deltas_pending charter register. */
function bundleWith(overrides = {}) {
  return {
    repo_manifest: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
    charter_register: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter",
      ceiling: { rung: "deep" },
      subsystems: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts", "src/b.ts"],
          charters: [charter("src/a.ts", "stated"), charter("src/a.ts", "revealed")],
        },
      ],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      validation_issues: [],
      deltas_pending: true,
      ...(overrides.charter_register ?? {}),
    },
    ...overrides,
  };
}

describe("runCharterDeltaExecutor — ingest path", () => {
  test("routes + gates a delta submission over the assembled charters", () => {
    const submission = {
      subsystems: [
        {
          node_id: "src/a.ts",
          deltas: [{ pair: ["stated", "revealed"], summary: "code drifted from intent" }],
        },
      ],
      goal_graph: { nodes: [{ id: "g1", label: "g1" }], edges: [] },
    };
    const run = runCharterDeltaExecutor(bundleWith(), submission);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
    const reg = run.updated.charter_register;
    expect(reg.deltas).toHaveLength(1);
    expect(reg.deltas[0].kind).toBe("spec_drift");
    expect(reg.deltas[0].routed_to).toBe("remediator");
    expect(reg.findings).toHaveLength(1);
    expect(reg.findings[0].category).toBe("charter_delta:spec_drift");
    expect(reg.findings[0].affected_files.map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(reg.goal_graph).toEqual(submission.goal_graph);
    // The charters authored by the extraction pass are preserved.
    expect(reg.subsystems.map((s) => s.node_id)).toEqual(["src/a.ts"]);
    // The independent miner has now run — the gate drops.
    expect(reg.deltas_pending).toBe(false);
  });

  test("appends its own gate drops to the register's existing validation issues", () => {
    const submission = {
      // inferred|revealed has no routing in the design's table → dropped.
      subsystems: [
        { node_id: "src/a.ts", deltas: [{ pair: ["stated", "revealed"], summary: "gap" }] },
      ],
    };
    const bundle = bundleWith({
      charter_register: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "deep" },
        subsystems: [
          {
            node_id: "src/a.ts",
            members: ["src/a.ts", "src/b.ts"],
            charters: [charter("src/a.ts", "stated"), charter("src/a.ts", "revealed")],
          },
        ],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        validation_issues: ["a pre-existing extraction gate drop"],
        deltas_pending: true,
      },
    });
    const run = runCharterDeltaExecutor(bundle, submission);
    expect(run.updated.charter_register.validation_issues[0]).toBe(
      "a pre-existing extraction gate drop",
    );
  });
});

describe("runCharterDeltaExecutor — omit / no-submission path", () => {
  test("no submission settles a deltas_pending register with no deltas", () => {
    const run = runCharterDeltaExecutor(bundleWith(), undefined);
    const reg = run.updated.charter_register;
    expect(reg.deltas).toHaveLength(0);
    expect(reg.findings).toHaveLength(0);
    expect(reg.deltas_pending).toBe(false);
    // The assembled charters survive the settle.
    expect(reg.subsystems.map((s) => s.node_id)).toEqual(["src/a.ts"]);
  });

  test("a register not awaiting deltas is settled unchanged (deltas_pending false)", () => {
    const bundle = bundleWith({
      charter_register: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "shallow" },
        status: "omitted",
        subsystems: [],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        validation_issues: [],
      },
    });
    const run = runCharterDeltaExecutor(bundle, { subsystems: [] });
    expect(run.updated.charter_register.deltas_pending).toBe(false);
    expect(run.updated.charter_register.status).toBe("omitted");
  });

  test("no register at all → writes a settled omitted register", () => {
    const run = runCharterDeltaExecutor(
      { repo_manifest: { files: [] } },
      undefined,
    );
    const reg = run.updated.charter_register;
    expect(reg.status).toBe("omitted");
    expect(reg.deltas_pending).toBe(false);
  });
});
