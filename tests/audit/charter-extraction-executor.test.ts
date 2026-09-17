import { test, expect, describe } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { CharterRegister } from "../../src/audit/types/charterRegister.js";
import type {
  CharterLaneGraph,
  CharterPacketManifest,
  Ceiling,
  CharterLaneSubmission as CharterSubmission,
  CharterLaneKind,
  IntentCheckpoint,
} from "audit-tools/shared";
import type { CharterExtractionMerged } from "../../src/audit/orchestrator/charterExtractionExecutor.js";

const {
  runCharterExtractionExecutor,
  resolveCharterCeiling,
  ceilingRequestsCharters,
  checkLaneCitations,
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

  test("a RUN-BOUND conceptual_depth:deep maps to a deep ceiling", () => {
    const confirmedAt = "2026-01-01T00:00:00Z";
    const cp: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: confirmedAt,
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { answered_at: confirmedAt, conceptual_depth: "deep" },
    };
    expect(resolveCharterCeiling(cp)).toEqual({ rung: "deep" });
  });

  test("an UNBOUND conceptual_depth:deep does NOT map to a deep ceiling — it stays at the default", () => {
    // The depth is a per-run dial, so a block this confirmation did not answer
    // must not raise the ceiling either. Pinned here because the ceiling is the
    // second thing derived from it, and a fix applied to only one reader leaves
    // the other quietly honoring an inherited answer.
    const cp: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-08-20T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: {
        answered_at: "2026-01-01T00:00:00Z",
        conceptual_depth: "deep",
      },
    };
    expect(resolveCharterCeiling(cp)).toEqual({ rung: "shallow" });
  });
});

// `attention` is the THIRD dial off the same block, and it was the one reader
// left unbound: `attention` decides whether the clarification loop pops
// INTERACTIVE questions at the operator, so an inherited value takes a run that
// never opted into a human loop and interrupts it. Same mechanism, same
// consequence; pinned here so a fix applied to depth and ceiling cannot leave
// this one quietly honoring a prior run's answer.
const { resolveClarificationAttention } = await import(
  "../../src/audit/orchestrator/charterClarificationExecutor.js"
);

describe("resolveClarificationAttention is RUN-BOUND", () => {
  function withAttention(
    attention: number,
    answeredAt: string,
    confirmedAt: string,
  ): IntentCheckpoint {
    return {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: confirmedAt,
      confirmed_by: "host",
      scope_summary: "s",
      intent_summary: "i",
      design_review: { answered_at: answeredAt, attention },
    };
  }

  test("honors the attention a block THIS confirmation answered supplies", () => {
    const at = "2026-08-20T00:00:00Z";
    expect(resolveClarificationAttention(withAttention(3, at, at))).toBe(3);
  });

  test("IGNORES the attention an earlier confirmation supplied", () => {
    expect(
      resolveClarificationAttention(
        withAttention(3, "2026-01-01T00:00:00Z", "2026-08-20T00:00:00Z"),
      ),
      "a run that never chose attention must not be interrupted by an inherited one",
    ).toBe(0);
  });

  test("defaults to 0 without a checkpoint or without a block", () => {
    expect(resolveClarificationAttention(undefined)).toBe(0);
    expect(resolveClarificationAttention(checkpoint())).toBe(0);
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
    const stated = renderCharterKindLanePrompt({
      kind: "stated",
      submissionPath: "/tmp/charter-extraction-stated.json",
      packetPath: "/tmp/charter-extraction-stated-packet.md",
    });
    // The stated/revealed scope separation is the whole point of independence.
    expect(stated).toContain("testimony");
    expect(stated).toContain("repo's doc files plus the comments extracted");
    // The three lanes are NAMED (the closed enum is rendered), but only the
    // stated packet is described — the revealed packet line never appears.
    expect(stated).not.toContain("comment-stripped source");
    // The lane's own kind reaches it in the HEADING, never as a field to fill.
    // The tool stamps the kind at merge, from the lane-bound submission path
    // (owner review of prompt 8, 2026-09-17).
    expect(stated).toContain("the **stated** lane");
    expect(stated).not.toContain('"kind": "stated"');
    // One DAG per lane: edges mean SERVES, no cycles, levels derived by the tool.
    expect(stated).toContain("SERVES");
    expect(stated).toContain("no cycles");
    expect(stated).not.toContain("next-step");

    const revealed = renderCharterKindLanePrompt({
      kind: "revealed",
      submissionPath: "/tmp/charter-extraction-revealed.json",
      packetPath: "/tmp/charter-extraction-revealed-packet.md",
    });
    expect(revealed).toContain("comment-stripped source");
    expect(revealed).toContain("BEHAVIOR");
    expect(revealed).toContain("the **revealed** lane");
    expect(revealed).not.toContain('"kind": "revealed"');
  });
});

/** A one-lane merged submission: the stated lane with the given nodes and edges. */
function merged(
  nodes: CharterSubmission["nodes"],
  edges: CharterSubmission["edges"] = [],
  kind: CharterLaneKind = "stated",
): CharterExtractionMerged {
  return { lanes: [{ kind, nodes, edges }] };
}

function node(
  node_id: string,
  over: Partial<CharterSubmission["nodes"][number]> = {},
): CharterSubmission["nodes"][number] {
  return {
    node_id,
    purpose: `exists so callers get audited output (${node_id})`,
    files: ["src/a.ts"],
    provenance: [],
    confidence: "high",
    ...over,
  };
}

describe("runCharterExtractionExecutor — omit path", () => {
  test("shallow ceiling writes an omitted register with no host turn", async () => {
    const run = await runCharterExtractionExecutor(bundleWith({ intent_checkpoint: checkpoint() }), undefined);
    requireCharterRegister(run);
    expect(run.artifacts_written).toEqual(["charter_register.json"]);
    const reg = run.updated.charter_register;
    expect(reg.status).toBe("omitted");
    expect(reg.lanes).toHaveLength(0);
    expect(reg.candidates).toHaveLength(0);
    expect(reg.comparison_pending).toBeUndefined();
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

describe("runCharterExtractionExecutor — ingest path (lane DAGs + candidates only)", () => {
  test("assembles each lane DAG, grounds scopes, proposes candidates, and defers the comparison", async () => {
    const submission: CharterExtractionMerged = {
      lanes: [
        { kind: "stated", nodes: [node("s1")], edges: [] },
        { kind: "revealed", nodes: [node("r1", { purpose: "optimizes for fast dispatch over coverage" })], edges: [] },
        // An invented file is grounded out of the scope; the node stays, provenance-only.
        { kind: "structural", nodes: [node("x1", { files: ["ghost.ts"] })], edges: [] },
      ],
    };
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.status).toBeUndefined();
    // Canonical kind order, never arrival order.
    expect(reg.lanes.map((l) => l.kind)).toEqual(["stated", "structural", "revealed"]);
    const structural = reg.lanes.find((l) => l.kind === "structural")!;
    expect(structural.nodes).toHaveLength(1);
    expect(structural.nodes[0]!.files).toBeUndefined();
    expect(reg.validation_issues.join()).toContain("outside the repo universe");
    // The tool half of step 2: s1 and r1 overlap on src/a.ts; x1 has no scope to overlap.
    expect(reg.candidates).toHaveLength(1);
    expect(reg.candidates[0]!.basis).toBe("file_overlap");
    // Steps 2–5 are the comparison reader's and the fidelity lane's — deferred.
    expect(reg.correspondences).toHaveLength(0);
    expect(reg.differences).toHaveLength(0);
    expect(reg.findings).toHaveLength(0);
    expect(reg.comparison_pending).toBe(true);
  });

  test("a cycle refuses every edge among its nodes, with a named issue; the nodes stay", async () => {
    const submission = merged(
      [node("a"), node("b")],
      [
        { from: "a", to: "b", provenance: [] },
        { from: "b", to: "a", provenance: [] },
      ],
    );
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      submission,
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.lanes[0]!.nodes).toHaveLength(2);
    expect(reg.lanes[0]!.edges).toHaveLength(0);
    expect(reg.validation_issues.join("\n")).toMatch(/cycle through "a", "b"/);
    expect(reg.comparison_pending).toBe(true);
  });

  test("every lane empty → comparison_pending false (the comparison pass self-satisfies)", async () => {
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      merged([]),
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.lanes.every((l) => l.nodes.length === 0)).toBe(true);
    expect(reg.comparison_pending).toBe(false);
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

function submissionCiting(ref: string): CharterExtractionMerged {
  return merged([node("s1", { provenance: [{ kind: "code", ref }] })]);
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
    expect(reg.validation_issues.some((i) => i.includes("src/a.ts:900-905"))).toBe(true);
    // …and the submitted provenance survives byte-identical (the guard half):
    // no nearest-enclosing-declaration repair, which was tried and rejected
    // repo-wide on 2026-07-28.
    const refs = reg.lanes.flatMap((l) => l.nodes.flatMap((n) => n.provenance.map((p) => p.ref)));
    expect(refs).toContain("src/a.ts:900-905");
  });

  test("edge provenance is checked too, owned by the edge it evidences", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      merged(
        [node("a"), node("b")],
        [{ from: "a", to: "b", provenance: [{ kind: "code", ref: "src/a.ts:900" }] }],
      ),
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.citation_validation.citation_count).toBe(1);
    expect(reg.citation_validation.failed_count).toBe(1);
    expect(reg.validation_issues.join("\n")).toContain("stated:a->b");
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
    expect(run.updated.charter_register.citation_validation.status).toBe("no_citations");
    expect(run.updated.charter_register.evidence_coverage).toEqual([]);
  });

  test("a non-path provenance kind is counted but not path-checked", async () => {
    const root = await fixtureRoot();
    const run = await runCharterExtractionExecutor(
      bundleWith({ intent_checkpoint: checkpoint("deep") }),
      merged([node("s1", { provenance: [{ kind: "intent_checkpoint", ref: "design_review.ceiling" }] })]),
      { root },
    );
    requireCharterRegister(run);
    const reg = run.updated.charter_register;
    expect(reg.citation_validation.citation_count).toBe(1);
    expect(reg.citation_validation.checked_count).toBe(0);
    expect(reg.validation_issues).toHaveLength(0);
  });
});

// The QUOTE-PRESENCE leg of `checkLaneCitations` — the half of the quote
// requirement that only this boundary can judge (owner decision, 2026-09-17:
// "do both").
//
// The lane gate refuses a quoteless citation that names a SPAN, because that is
// unverifiable whatever the context. It cannot refuse a quoteless BARE path,
// because the same citation is honest or evasive depending on a fact the gate
// does not hold: `charterPackets.ts` delivers some files as a file-tree path with
// NO excerpt, and for those the bare path is the lane's only truthful citation.
// Only the packet manifest tells the two apart, and only this function holds it.
//
// Every case below is driven through `checkLaneCitations` directly, because the
// executor loads its manifests from an artifacts directory and the property under
// test is the rule, not the load.
function laneCiting(
  provenance: { kind: string; ref: string; quote?: string }[],
): CharterLaneGraph[] {
  return [
    {
      kind: "stated",
      nodes: [
        {
          node_id: "s1",
          purpose: "keep every promise the service gives a customer",
          premise_height: 0,
          provenance: provenance as CharterLaneGraph["nodes"][number]["provenance"],
          confidence: "high",
        },
      ],
      edges: [],
    },
  ];
}

function manifestDelivering(...paths: string[]): CharterPacketManifest[] {
  return [
    {
      schema_version: "charter-packet-manifest/v1",
      kind: "stated",
      excerpts: paths.map((source_path, i) => ({
        excerpt_id: `e${i}`,
        source_path,
        evidence_class: "doc_prose" as CharterPacketManifest["excerpts"][number]["evidence_class"],
        line_runs: [{ start: 1, end: 3 }],
        line_count: 3,
        prefix_width: 4,
      })),
      coverage: { kind: "stated", classes: [] },
    },
  ];
}

describe("checkLaneCitations — the quote-presence leg", () => {
  test("refuses a quoteless citation of a file the packet EXCERPTED", async () => {
    const root = await fixtureRoot();
    const result = checkLaneCitations(laneCiting([{ kind: "code", ref: "src/a.ts" }]), {
      root,
      manifests: manifestDelivering("src/a.ts"),
    });
    expect(result.issues.join("\n")).toContain("carries no quote");
    expect(result.issues.join("\n")).toContain("src/a.ts");
    expect(result.summary.failed_count).toBe(1);
    expect(result.summary.quote_presence_checked).toBe(true);
  });

  test("ACCEPTS a quoteless citation of a file the packet delivered as a tree entry alone", async () => {
    // The rule the design gate found: refusing this would red an HONEST citation
    // and press the lane into fabricating a quote.
    const root = await fixtureRoot();
    const result = checkLaneCitations(laneCiting([{ kind: "code", ref: "src/a.ts" }]), {
      root,
      manifests: manifestDelivering("src/b.ts"),
    });
    expect(result.issues).toHaveLength(0);
    expect(result.summary.failed_count).toBe(0);
    expect(result.summary.quote_presence_checked).toBe(true);
  });

  test("accepts a QUOTED citation of an excerpted file", async () => {
    const root = await fixtureRoot();
    const result = checkLaneCitations(
      laneCiting([{ kind: "code", ref: "src/a.ts", quote: "beta" }]),
      { root, manifests: manifestDelivering("src/a.ts") },
    );
    expect(result.issues).toHaveLength(0);
  });

  test("an EMPTY quote reads as no quote", async () => {
    const root = await fixtureRoot();
    const result = checkLaneCitations(
      laneCiting([{ kind: "code", ref: "src/a.ts", quote: "   " }]),
      { root, manifests: manifestDelivering("src/a.ts") },
    );
    expect(result.issues.join("\n")).toContain("carries no quote");
  });

  test("with NO manifest the leg ABSTAINS and says so, never passes silently", async () => {
    const root = await fixtureRoot();
    const result = checkLaneCitations(laneCiting([{ kind: "code", ref: "src/a.ts" }]), {
      root,
      manifests: [],
    });
    expect(result.issues).toHaveLength(0);
    expect(
      result.summary.quote_presence_checked,
      "an empty issue list must never be indistinguishable from a leg that never ran",
    ).toBe(false);
  });

  test("the leg still reports with NO repository root — it reads the manifest, not the disk", () => {
    // The grounding leg abstains without a root. This one does not depend on the
    // root at all, so folding it in after that early return would have silently
    // skipped it on every rootless ingest.
    const result = checkLaneCitations(laneCiting([{ kind: "code", ref: "src/a.ts" }]), {
      manifests: manifestDelivering("src/a.ts"),
    });
    expect(result.summary.status).toBe("not_run");
    expect(result.summary.quote_presence_checked).toBe(true);
    expect(result.issues.join("\n")).toContain("carries no quote");
    expect(result.summary.failed_count).toBe(1);
  });

  test("a non-path provenance kind is left alone even when its ref matches an excerpt", async () => {
    const root = await fixtureRoot();
    const result = checkLaneCitations(
      laneCiting([{ kind: "intent_checkpoint", ref: "src/a.ts" }]),
      { root, manifests: manifestDelivering("src/a.ts") },
    );
    expect(result.issues).toHaveLength(0);
  });

  test("a `#symbol` ref resolves to its FILE before the excerpt lookup", async () => {
    // The manifest records a path; the lane cites a span inside it. Comparing the
    // raw ref would have missed every anchored citation.
    const root = await fixtureRoot();
    const result = checkLaneCitations(
      laneCiting([{ kind: "code", ref: "src/a.ts#alpha", quote: "alpha" }]),
      { root, manifests: manifestDelivering("src/a.ts") },
    );
    expect(result.issues).toHaveLength(0);
    const quoteless = checkLaneCitations(
      laneCiting([{ kind: "code", ref: "src/a.ts#alpha" }]),
      { root, manifests: manifestDelivering("src/a.ts") },
    );
    expect(quoteless.issues.join("\n")).toContain("carries no quote");
  });
});
