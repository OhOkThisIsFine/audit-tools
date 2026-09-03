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

type CharterRun = Awaited<ReturnType<typeof runCharterExtractionExecutor>>;

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
  test("shallow ceiling writes an omitted register with no host turn", async () => {
    const run = await runCharterExtractionExecutor(bundleWith({ intent_checkpoint: checkpoint() }), undefined);
    requireCharterRegister(run);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
    const reg = run.updated.charter_register;
    expect(reg.status).toBe("omitted");
    expect(reg.subsystems).toHaveLength(0);
    expect(reg.deltas).toHaveLength(0);
    expect(reg.ceiling).toEqual({ rung: "shallow" });
  });

  test("deep ceiling but no submission records an empty register", async () => {
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      undefined,
    );
    requireCharterRegister(run);
    expect(run.updated.charter_register.status).toBe("omitted");
    expect(run.progress_summary).toContain("no submission");
  });
});

describe("runCharterExtractionExecutor — ingest path (charters only)", () => {
  test("assembles + gates charters grounded against the consensus scaffold, deferring deltas", async () => {
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
    const run = await runCharterExtractionExecutor(
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

  test("multiple charters of the same kind are merged into the teleology; best is selected for the charter", async () => {
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
    const run = await runCharterExtractionExecutor(
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

  test("no consensus subsystems → deltas_pending false (delta pass self-satisfies)", async () => {
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
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.subsystems).toHaveLength(0);
    expect(reg.deltas_pending).toBe(false);
  });
});

// ── The register is CHECKED, not self-certified ──────────────────────────────
//
// Both live runs printed `validation_issues: []` — one at 1-of-15 correct
// citations, one at 75-of-75 — because the field's only two producers were
// node-file membership and the True-charter gate, while the overshoots lived in
// `provenance[].ref`, which nothing read.

/** A real 3-line file on disk: the citation check counts lines, so it needs one. */
async function fixtureRoot(): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "charter-citation-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "alpha\nbeta\ngamma\n", "utf8");
  return root;
}

function submissionCiting(ref: string): CharterSubmission {
  return {
    nodes: [
      {
        kind: "stated",
        purpose: "exists so callers get audited output",
        premise_height: 0,
        files: ["src/a.ts"],
        provenance: [{ kind: "code", ref }],
        confidence: "high",
      },
    ],
  };
}

describe("runCharterExtractionExecutor — citation validation", () => {
  test("T6: a citation whose END line exceeds the file's length fails the register", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submissionCiting("src/a.ts:900-905"),
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.validation_issues.join("\n")).toContain("src/a.ts:900-905");
    expect(reg.validation_issues.join("\n")).toContain("line_out_of_range");
    expect(reg.citation_validation.failed_count).toBe(1);
  });

  test("T7: a clean run affirms that the check RAN, with a stated count", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submissionCiting("src/a.ts:2"),
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    // An empty issue list is unfalsifiable ALONE — it must sit beside the
    // affirmation and the count.
    expect(reg.validation_issues).toHaveLength(0);
    expect(reg.citation_validation.status).toBe("checked");
    expect(reg.citation_validation.citation_count).toBe(1);
    expect(reg.citation_validation.checked_count).toBe(1);
    expect(reg.citation_validation.failed_count).toBe(0);
  });

  test("T8: a bad line number is REPORTED unchanged, never repaired", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submissionCiting("src/a.ts:900-905"),
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    // The issue NAMES the ref (the red half)…
    expect(reg.validation_issues.some((i) => i.includes("src/a.ts:900-905"))).toBe(
      true,
    );
    // …and the submitted provenance survives byte-identical (the guard half):
    // no nearest-enclosing-declaration repair, which was tried and rejected
    // repo-wide on 2026-07-28.
    const refs = reg.subsystems.flatMap((s) =>
      s.charters.flatMap((c) => (c.provenance ?? []).map((p) => p.ref)),
    );
    expect(refs).toContain("src/a.ts:900-905");
  });

  test("with NO root, the check is a recorded abstention — never an implicit pass", async () => {
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submissionCiting("src/a.ts:900-905"),
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.citation_validation.status).toBe("not_run");
    expect(reg.citation_validation.citation_count).toBe(1);
    expect(reg.citation_validation.checked_count).toBe(0);
    expect(reg.validation_issues).toHaveLength(0);
  });

  test("the omit path reports no_citations, never `checked` over work it never examined", async () => {
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint() }),
      undefined,
    );
    requireCharterRegister(run);
    expect(run.updated.charter_register.citation_validation.status).toBe(
      "no_citations",
    );
    expect(run.updated.charter_register.evidence_coverage).toEqual([]);
  });

  test("a non-path provenance kind is counted but not path-checked", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      {
        nodes: [
          {
            kind: "stated",
            purpose: "exists so callers get audited output",
            premise_height: 0,
            files: ["src/a.ts"],
            provenance: [{ kind: "intent_checkpoint", ref: "design_review.ceiling" }],
            confidence: "high",
          },
        ],
      },
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.citation_validation.citation_count).toBe(1);
    expect(reg.citation_validation.checked_count).toBe(0);
    expect(reg.validation_issues).toHaveLength(0);
  });
});
