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
  test("deep ceiling requests THREE lanes; deepest adds the true lane", () => {
    expect(charterExtractionKindsForCeiling({ rung: "deep" })).toEqual([
      "stated",
      "inferred",
      "revealed",
    ]);
    expect(charterExtractionKindsForCeiling({ rung: "deepest" })).toEqual([
      "stated",
      "inferred",
      "revealed",
      "true",
    ]);
  });

  test("each lane prompt carries ONLY its own kind's scope, blind to the others", () => {
    const stated = renderCharterKindLanePrompt(bundleWith(), {
      kind: "stated",
      submissionPath: "/tmp/charter-extraction-stated.json",
    });
    // The stated/revealed scope separation is the whole point of independence.
    expect(stated).toContain("Read ONLY docs / specs / READMEs / header comments");
    expect(stated).not.toContain("ONLY the subsystem's CODE");
    expect(stated).toContain("BLIND to the other kinds");
    expect(stated).toContain('"kind": "stated"');
    // Deltas are still deferred to the independent miner; lanes are advance-free.
    expect(stated).toContain("do NOT emit deltas");
    expect(stated).not.toContain("next-step");

    const revealed = renderCharterKindLanePrompt(bundleWith(), {
      kind: "revealed",
      submissionPath: "/tmp/charter-extraction-revealed.json",
    });
    expect(revealed).toContain("Read ONLY the subsystem's CODE");
    expect(revealed).not.toContain("ONLY docs / specs / READMEs");
  });

  test("the true lane carries the shining-city provocation contract", () => {
    const prompt = renderCharterKindLanePrompt(bundleWith(), {
      kind: "true",
      submissionPath: "/tmp/charter-extraction-true.json",
    });
    expect(prompt).toContain("shining city");
    expect(prompt).toContain("nominated_alternative");
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
      subsystems: [
        {
          node_id: "src/a.ts",
          charters: [
            { kind: "stated", purpose: "exists so callers get audited output", provenance: [], confidence: "high" },
            { kind: "revealed", purpose: "optimizes for fast dispatch over coverage", provenance: [], confidence: "high" },
          ],
        },
        // An invented subsystem must be grounded out.
        { node_id: "ghost.ts", charters: [] },
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
    expect(reg.validation_issues.join()).toContain("not a consensus node");
  });

  test("a dropped over-count charter (>1 of a kind) surfaces its message in progress_summary, not just a count", () => {
    // "kept the first, dropped the rest" was recorded into validation_issues but
    // the progress summary showed only "N gate drop(s)" — the operator never saw
    // WHICH charter was discarded or why (2026-07-10 dogfooding). The message must
    // now appear in the surfaced summary.
    const submission: CharterSubmission = {
      subsystems: [
        {
          node_id: "src/a.ts",
          charters: [
            { kind: "stated", purpose: "exists so callers get audited output", provenance: [], confidence: "high" },
            { kind: "stated", purpose: "a SECOND stated charter — over-count, must be dropped", provenance: [], confidence: "high" },
          ],
        },
      ],
    };
    const run = runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    expect(run.progress_summary).toContain("gate drop(s):");
    expect(run.progress_summary).toContain('more than one "stated" charter');
    // The drop is still recorded in the register too (surfacing is additive).
    expect(run.updated.charter_register.validation_issues.join()).toContain('more than one "stated" charter');
  });

  test("no consensus subsystems → deltas_pending false (delta pass self-satisfies)", () => {
    // ghost.ts is grounded out, so no subsystem survives → nothing to mine.
    const submission: CharterSubmission = {
      subsystems: [{ node_id: "ghost.ts", charters: [] }],
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
