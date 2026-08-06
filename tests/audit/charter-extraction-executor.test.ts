import { test, expect, describe } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import type {
  Ceiling,
  CharterSubmission,
  IntentCheckpoint,
} from "audit-tools/shared";

const {
  runCharterExtractionExecutor,
  resolveCharterCeiling,
  ceilingRequestsCharters,
} = await import("../../src/audit/orchestrator/charterExtractionExecutor.js");

const { renderCharterKindLanePrompt, charterExtractionKindsForCeiling } = await import(
  "../../src/audit/cli/charterExtractionPrompt.js"
);

function bundleWith(overrides: ArtifactBundle = {}): ArtifactBundle {
  return {
    repo_manifest: {
      generated_at: "2026-01-01T00:00:00.000Z",
      repository: { name: "test-repo" },
      files: [
        { path: "src/a.ts", language: "typescript", size_bytes: 100 },
        { path: "src/b.ts", language: "typescript", size_bytes: 100 },
      ],
    },
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

function checkpoint(rung?: Ceiling["rung"]): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-01-01T00:00:00Z",
    confirmed_by: "host",
    scope_summary: "s",
    intent_summary: "i",
    design_review: rung ? { ceiling: { rung } } : {},
  };
}

type CharterRun = ReturnType<typeof runCharterExtractionExecutor>;

function requireCharterRegister(
  run: CharterRun,
): asserts run is CharterRun & {
  updated: ArtifactBundle & { charter_register: CharterRegister };
} {
  if (!run.updated.charter_register) {
    throw new Error("charter register was not written");
  }
}

describe("resolveCharterCeiling / ceilingRequestsCharters", () => {
  test("defaults to shallow when no checkpoint / no design_review", () => {
    expect(resolveCharterCeiling(undefined)).toEqual({ rung: "shallow" });
    expect(ceilingRequestsCharters({ rung: "shallow" })).toBe(false);
    expect(ceilingRequestsCharters({ rung: "deep" })).toBe(true);
    expect(ceilingRequestsCharters({ rung: "deepest" })).toBe(true);
  });

  test("legacy conceptual_depth:deep maps to a deep ceiling", () => {
    const cp: IntentCheckpoint = {
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

describe("charter extraction per-kind lanes — ceiling-aware kinds + blind scopes", () => {
  // Always-materialized (design resolution 2): each kind is its own blind LANE
  // prompt; independence is the shape of the artifacts, not a merge instruction.
  test("deep ceiling requests THREE estimator lanes (true is nominated, not extracted)", () => {
    expect(charterExtractionKindsForCeiling({ rung: "deep" })).toEqual([
      "stated",
      "structural",
      "revealed",
    ]);
    expect(charterExtractionKindsForCeiling({ rung: "deepest" })).toEqual([
      "stated",
      "structural",
      "revealed",
    ]);
  });

  test("each lane prompt carries ONLY its own kind's scope, blind to the others", () => {
    const stated = renderCharterKindLanePrompt(bundleWith(), {
      kind: "stated",
      submissionPath: "/tmp/charter-extraction-stated.json",
      packetPath: "/tmp/charter-extraction-stated-packet.md",
    });
    // The stated/revealed scope separation is the whole point of independence.
    expect(stated).toContain("testimony");
    expect(stated).toContain("repo's doc files plus the comments extracted");
    expect(stated).not.toContain("comment-stripped");
    expect(stated).toContain("independent, blind lanes");
    expect(stated).toContain('"kind": "stated"');
    // Deltas are still deferred to the independent miner; lanes are advance-free.
    expect(stated).toContain("do NOT emit deltas");
    expect(stated).not.toContain("next-step");

    const revealed = renderCharterKindLanePrompt(bundleWith(), {
      kind: "revealed",
      submissionPath: "/tmp/charter-extraction-revealed.json",
      packetPath: "/tmp/charter-extraction-revealed-packet.md",
    });
    expect(revealed).toContain("comment-stripped source");
    expect(revealed).toContain("BEHAVIOR");
    expect(revealed).not.toContain("docs");
  });

});

describe("runCharterExtractionExecutor — omit path", () => {
  test("shallow ceiling writes an omitted register with no host turn", () => {
    const run = runCharterExtractionExecutor(bundleWith({ intent_checkpoint: checkpoint() }), undefined);
    requireCharterRegister(run);
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
    requireCharterRegister(run);
    expect(run.updated.charter_register.status).toBe("omitted");
    expect(run.progress_summary).toContain("no submission");
  });
});

describe("runCharterExtractionExecutor — ingest path (charters only)", () => {
  test("assembles + gates charters grounded against the consensus scaffold, deferring deltas", () => {
    const submission: CharterSubmission = {
      nodes: [
        {
          kind: "stated",
          purpose: "exists so callers get audited output",
          premise_height: 0,
          files: ["src/a.ts"],
          provenance: [],
          confidence: "high",
        },
        {
          kind: "revealed",
          purpose: "optimizes for fast dispatch over coverage",
          premise_height: 0,
          files: ["src/a.ts"],
          provenance: [],
          confidence: "high",
        },
        // An invented file must be grounded out.
        {
          kind: "structural",
          purpose: "organize by dispatch",
          premise_height: 0,
          files: ["ghost.ts"],
          provenance: [],
          confidence: "high",
        },
      ],
    };
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.status).toBeUndefined();
    expect(reg.subsystems.map((s) => s.node_id)).toEqual(["src/a.ts"]);
    // Charters only: deltas + findings + goal_graph are the INDEPENDENT delta
    // pass's product, deferred here and flagged deltas_pending.
    expect(reg.deltas).toHaveLength(0);
    expect(reg.findings).toHaveLength(0);
    expect(reg.goal_graph).toEqual({ nodes: [], edges: [] });
    expect(reg.deltas_pending).toBe(true);
    expect(reg.validation_issues.join()).toContain("outside the repo universe");
  });

  test("multiple charters of the same kind are merged into the teleology; best is selected for the charter", () => {
    // Design v2: multiple nodes of the same kind in a unit are merged into
    // the teleology (all preserved by premise_height + purpose), and the
    // best-overlap node is selected for the unit's charter. No gate drop.
    const submission: CharterSubmission = {
      nodes: [
        {
          kind: "stated",
          purpose: "exists so callers get audited output",
          premise_height: 0,
          files: ["src/a.ts"],
          provenance: [],
          confidence: "high",
        },
        {
          kind: "stated",
          purpose: "optimize for speed",
          premise_height: 1,
          files: ["src/a.ts", "src/b.ts"],
          provenance: [],
          confidence: "high",
        },
      ],
    };
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.subsystems).toHaveLength(1);
    const subsys = reg.subsystems[0];
    // Both nodes persist in teleology, sorted by premise_height then purpose
    expect(subsys.teleologies.stated).toHaveLength(2);
    expect(subsys.teleologies.stated?.[0].purpose).toBe("exists so callers get audited output");
    expect(subsys.teleologies.stated?.[1].purpose).toBe("optimize for speed");
    // The best-overlap charter (src/a.ts:src/b.ts) is selected for the charter
    expect(subsys.charters[0].purpose).toBe("optimize for speed");
    // No gate drops — validation_issues should be empty
    expect(reg.validation_issues).toHaveLength(0);
  });

  test("no consensus subsystems → deltas_pending false (delta pass self-satisfies)", () => {
    // ghost.ts is grounded out (not in repo), so no subsystem survives → nothing to mine.
    const submission: CharterSubmission = {
      nodes: [
        {
          kind: "stated",
          purpose: "organize by dispatch",
          premise_height: 0,
          files: ["ghost.ts"],
          provenance: [],
          confidence: "high",
        },
      ],
    };
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.subsystems).toHaveLength(0);
    expect(reg.deltas_pending).toBe(false);
  });
});
