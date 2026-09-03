import { REGISTER_V4_AFFIRMATION } from "../helpers/charterRegisterFixture.js";
import { test, expect, describe } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import type {
  Charter,
  CharterConfidence,
  CharterDeltaSubmission,
  CharterKind,
} from "audit-tools/shared";

const { runCharterDeltaExecutor } = await import(
  "../../src/audit/orchestrator/charterDeltaExecutor.js"
);

/** A charter as it appears in an ASSEMBLED register (charter_id already assigned). */
function charter(
  node_id: string,
  kind: CharterKind,
  confidence: CharterConfidence = "high",
): Charter {
  return {
    charter_id: `${node_id}:${kind}`,
    kind,
    purpose: `telos of ${kind}`,
    provenance: [],
    confidence,
  };
}

/** A bundle carrying an assembled, deltas_pending charter register. */
function bundleWith(
  overrides: { repo_manifest?: ArtifactBundle["repo_manifest"]; charter_register?: CharterRegister } = {},
): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "src/b.ts", language: "typescript", size_bytes: 100 },
      ],
    },
    charter_register: {
      schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "charter",
      ceiling: { rung: "deep" },
      subsystems: [
        {
          node_id: "src/a.ts",
          members: ["src/a.ts", "src/b.ts"],
          charters: [charter("src/a.ts", "stated"), charter("src/a.ts", "revealed")],
          teleologies: {},
        },
      ],
      goal_graph: { nodes: [], edges: [] },
      deltas: [],
      findings: [],
      triangulated: [],
      disagreement: [],
      validation_issues: [],
      ...REGISTER_V4_AFFIRMATION,
      deltas_pending: true,
      ...(overrides.charter_register ?? {}),
    },
    ...overrides,
  };
}

describe("runCharterDeltaExecutor — ingest path", () => {
  test("routes + gates a delta submission over the assembled charters", () => {
    const submission: CharterDeltaSubmission = {
      subsystems: [
        {
          node_id: "src/a.ts",
          deltas: [{ pair: ["stated", "revealed"], summary: "code drifted from intent" }],
        },
      ],
      triangulated: [],
      true_nominations: [],
      goal_graph: {
        nodes: [{ node_id: "g1", premise_height: 0, statement: "g1" }],
        edges: [],
      },
    };
    const run = runCharterDeltaExecutor(bundleWith(), submission);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
    const reg = run.updated.charter_register!;
    expect(reg.deltas).toHaveLength(1);
    expect(reg.deltas[0].kind).toBe("says_does_drift");
    expect(reg.deltas[0].routed_to).toBe("remediator");
    expect(reg.findings).toHaveLength(1);
    expect(reg.findings[0].category).toBe("charter_delta:says_does_drift");
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
    const submission: CharterDeltaSubmission = {
      subsystems: [
        { node_id: "src/a.ts", deltas: [{ pair: ["stated", "revealed"], summary: "gap" }] },
      ],
      triangulated: [],
      true_nominations: [],
    };
    const bundle = bundleWith({
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "deep" },
        subsystems: [
          {
            node_id: "src/a.ts",
            members: ["src/a.ts", "src/b.ts"],
            charters: [charter("src/a.ts", "stated"), charter("src/a.ts", "revealed")],
            teleologies: {},
          },
        ],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        triangulated: [],
        disagreement: [],
        validation_issues: ["a pre-existing extraction gate drop"],
        ...REGISTER_V4_AFFIRMATION,
        deltas_pending: true,
      },
    });
    const run = runCharterDeltaExecutor(bundle, submission);
    expect(run.updated.charter_register!.validation_issues[0]).toBe(
      "a pre-existing extraction gate drop",
    );
  });
});

describe("runCharterDeltaExecutor — omit / no-submission path", () => {
  test("no submission settles a deltas_pending register with no deltas", () => {
    const run = runCharterDeltaExecutor(bundleWith(), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.deltas).toHaveLength(0);
    expect(reg.findings).toHaveLength(0);
    expect(reg.deltas_pending).toBe(false);
    // The assembled charters survive the settle.
    expect(reg.subsystems.map((s) => s.node_id)).toEqual(["src/a.ts"]);
  });

  // A dead miner and a clean one used to be the same event on this path. The
  // settle now records the distinction: deltas are UNMINED, not affirmed-clean.
  test("a deltas_pending settle WITHOUT a submission is marked UNMINED on the register", () => {
    const run = runCharterDeltaExecutor(bundleWith(), undefined);
    const reg = run.updated.charter_register!;
    expect(reg.validation_issues.join()).toContain("without a miner submission");
    expect(reg.validation_issues.join()).toContain("UNMINED");
  });

  test("a not-pending settle carries NO dead-miner mark (nothing was awaited)", () => {
    const bundle = bundleWith({
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "shallow" },
        status: "omitted",
        subsystems: [],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        triangulated: [],
        disagreement: [],
        validation_issues: [],
        ...REGISTER_V4_AFFIRMATION,
      },
    });
    const run = runCharterDeltaExecutor(bundle, undefined);
    expect(run.updated.charter_register!.validation_issues).toHaveLength(0);
  });

  test("a register not awaiting deltas is settled unchanged (deltas_pending false)", () => {
    const bundle = bundleWith({
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "charter",
        ceiling: { rung: "shallow" },
        status: "omitted",
        subsystems: [],
        goal_graph: { nodes: [], edges: [] },
        deltas: [],
        findings: [],
        triangulated: [],
        disagreement: [],
        validation_issues: [],
        ...REGISTER_V4_AFFIRMATION,
      },
    });
    const run = runCharterDeltaExecutor(bundle, { subsystems: [], no_deltas: true, triangulated: [], true_nominations: [] });
    expect(run.updated.charter_register!.deltas_pending).toBe(false);
    expect(run.updated.charter_register!.status).toBe("omitted");
  });

  test("no register at all → writes a settled omitted register", () => {
    const run = runCharterDeltaExecutor(
      {
        repo_manifest: {
          repository: { name: "test-repo" },
          generated_at: "2026-01-01T00:00:00.000Z",
          files: [],
        },
      },
      undefined,
    );
    const reg = run.updated.charter_register!;
    expect(reg.status).toBe("omitted");
    expect(reg.deltas_pending).toBe(false);
  });
});
