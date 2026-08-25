import { describe, test, expect } from "vitest";

// Phase E — the systemic improvement-seeking challenge loop. Import the pure module
// + the executor from source (tsx loader) so un-rebuilt changes are caught.
import { aggregateMetricsDigest } from "../../src/audit/systemic/aggregateMetricsDigest.js";
import { foldChallengeRound } from "../../src/audit/systemic/systemicChallengeLoop.js";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import { runSystemicChallengeExecutor } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";
import { mergeFindings } from "../../src/audit/reporting/mergeFindings.js";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { Finding, RepoManifest } from "../../src/audit/types.js";
import type { SystemicChallengeRegister } from "../../src/audit/types/systemicChallenge.js";
import type {
  Ceiling,
  DecomposedNode,
  GoalGraph,
  IntentCheckpoint,
} from "../../src/shared/index.js";

// ── The aggregate-metrics digest (language-neutral) ──────────────────────────

describe("aggregateMetricsDigest", () => {
  test("derives language-neutral abstract counts from the bundle", () => {
    const node = (node_id: string, contested: boolean): DecomposedNode => ({
      node_id,
      members: [node_id],
      agreed_across_source: contested ? 0.25 : 1,
      stable_across_scale: contested ? 0.25 : 1,
      contested,
    });
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "systemic-challenge", root: "/repo" },
        generated_at: "2026-01-01T00:00:00.000Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 10 },
          { path: "src/b.ts", language: "typescript", size_bytes: 10 },
        ],
      },
      unit_manifest: {
        units: ["u1", "u2", "u3"].map((unit_id) => ({
          unit_id,
          name: unit_id,
          files: [],
          required_lenses: [],
        })),
      },
      structure_decomposition: {
        generated_at: "2026-01-01T00:00:00.000Z",
        target: "structure",
        node_universe_size: 3,
        source_ids: ["test"],
        consensus: [node("consensus", false)],
        contested: [node("contested-1", true), node("contested-2", true)],
        findings: [],
      },
      audit_tasks: ["t1", "t2", "t3", "t4"].map((task_id) => ({
        task_id,
        unit_id: "u1",
        pass_id: "p1",
        lens: "correctness",
        file_paths: [],
        rationale: "metrics fixture",
      })),
      graph_bundle: {
        graphs: {
          imports: [
            { from: "a", to: "b" },
            { from: "a", to: "c" },
            { from: "b", to: "c" },
          ],
        },
      },
    };
    const digest = aggregateMetricsDigest(bundle);
    const byLabel = Object.fromEntries(digest.rollups.map((r) => [r.label, r.count]));
    expect(byLabel["Components"]).toBe(2);
    expect(byLabel["Analysis units"]).toBe(3);
    expect(byLabel["Consensus subsystems"]).toBe(1);
    expect(byLabel["Contested subsystems"]).toBe(2);
    expect(byLabel["Planned audit tasks"]).toBe(4);
    expect(digest.total_edges).toBe(3);
    // node `a` has out-degree 2 (the max fan-out).
    expect(digest.max_fan_out).toBe(2);
  });

  test("labels are ecosystem-free (language-neutral) — no tool/language names", () => {
    const digest = aggregateMetricsDigest({});
    const text = JSON.stringify(digest).toLowerCase();
    for (const banned of ["vitest", "eslint", "npm", "typescript", "webpack", "jest"]) {
      expect(text.includes(banned)).toBe(false);
    }
  });

  test("an empty bundle yields a valid all-zero digest (never throws)", () => {
    const digest = aggregateMetricsDigest({});
    expect(digest.total_edges).toBe(0);
    expect(digest.max_fan_out).toBe(0);
    expect(digest.rollups.every((r) => r.count === 0)).toBe(true);
  });
});

// ── The loop-until-dry fold (reuses Phase D primitives) ──────────────────────

const mkFinding = (
  id: string,
  lens: string,
  title: string,
  files: string[] = ["src/a.ts"],
): Finding => ({
  id,
  title,
  category: "systemic_improvement",
  severity: "medium",
  confidence: "medium",
  lens,
  summary: `improve ${id}`,
  affected_files: files.map((path) => ({ path })),
});

const repoManifest: RepoManifest = {
  repository: { name: "systemic-challenge", root: "/repo" },
  generated_at: "2026-01-01T00:00:00.000Z",
  files: [
    { path: "src/a.ts", language: "typescript", size_bytes: 10 },
    { path: "src/b.ts", language: "typescript", size_bytes: 10 },
  ],
};

describe("foldChallengeRound", () => {
  test("preserves the adversary-tagged TRUE lens (never rewrites to architecture)", () => {
    const folded = foldChallengeRound({
      prior: [],
      submitted: [
        mkFinding("t1", "tests", "Parallelize the release suite"),
        mkFinding("o1", "operability", "Collapse the duplicated deploy step"),
      ],
      repoManifest,
    });
    const byId = Object.fromEntries(folded.findings.map((f) => [f.id, f.lens]));
    expect(byId.t1).toBe("tests");
    expect(byId.o1).toBe("operability");
    expect(folded.findings.every((f) => f.systemic === true)).toBe(true);
  });

  test("a round that adds nothing new is DRY (loop-until-dry terminator)", () => {
    const prior = foldChallengeRound({
      prior: [],
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    }).findings;
    // Re-submit the SAME finding (same lens+category+title) → nothing new → dry.
    const again = foldChallengeRound({
      prior,
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    });
    expect(again.new_finding_ids).toHaveLength(0);
    expect(again.dry).toBe(true);
  });

  test("a round that adds a NEW improvement is not dry", () => {
    const prior = foldChallengeRound({
      prior: [],
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    }).findings;
    const next = foldChallengeRound({
      prior,
      submitted: [mkFinding("p1", "performance", "Cache the recomputed index")],
      repoManifest,
    });
    expect(next.new_finding_ids).toEqual(["p1"]);
    expect(next.dry).toBe(false);
    // Both findings survive, blast-ordered then id-ordered.
    expect(next.findings.map((f) => f.id).sort()).toEqual(["p1", "t1"]);
  });

  test("an empty submission is trivially dry (converges immediately)", () => {
    const folded = foldChallengeRound({ prior: [], submitted: [], repoManifest });
    expect(folded.dry).toBe(true);
    expect(folded.new_finding_ids).toHaveLength(0);
  });

  test("an ungrounded improvement (no real component) is dropped, not surfaced", () => {
    const folded = foldChallengeRound({
      prior: [],
      submitted: [mkFinding("x1", "tests", "Points at nothing", ["src/ghost.ts"])],
      repoManifest,
    });
    expect(folded.findings).toHaveLength(0);
    expect(folded.new_finding_ids).toHaveLength(0);
    expect(folded.validation_issues.some((i) => i.includes("ungrounded"))).toBe(true);
  });

  test("blast radius refines from the goal DAG (reuses the Phase D primitive)", () => {
    const goalGraph: GoalGraph = {
      nodes: [
        { node_id: "leaf", premise_height: 1, statement: "l" },
        { node_id: "telos", premise_height: 0, statement: "t" },
      ],
      edges: [{ from: "leaf", to: "telos" }],
    };
    const folded = foldChallengeRound({
      prior: [],
      submitted: [mkFinding("g1", "architecture", "Rework subsystem")],
      goalGraph,
      repoManifest,
      goalNodeOf: () => "leaf",
    });
    // leaf → {telos} = blast radius 1.
    expect(folded.findings[0].blast_radius).toBe(1);
  });

});

// ── The mergeFindings true-lens seam ─────────────────────────────────────────

describe("mergeFindings systemic true-lens seam", () => {
  test("systemic findings enter with their TRUE lens, not collapsed into architecture", () => {
    const systemicChallenge: SystemicChallengeRegister = {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "systemic_challenge",
      ceiling: { rung: "deep" },
      rounds: [],
      converged: true,
      findings: [
        { ...mkFinding("s1", "tests", "Parallelize the release suite"), systemic: true },
        { ...mkFinding("s2", "operability", "Collapse the deploy step"), systemic: true },
      ],
      validation_issues: [],
    };
    const merged = mergeFindings([], undefined, undefined, undefined, undefined, undefined, systemicChallenge);
    const lensById = Object.fromEntries(merged.map((f) => [f.title, f.lens]));
    expect(lensById["Parallelize the release suite"]).toBe("tests");
    expect(lensById["Collapse the deploy step"]).toBe("operability");
    // None was rewritten to architecture.
    expect(merged.some((f) => f.lens === "architecture")).toBe(false);
  });

  test("byte-identical result when the systemic register is absent (back-compat)", () => {
    const withoutArg = mergeFindings([], undefined, undefined, undefined, undefined, undefined);
    const withUndef = mergeFindings([], undefined, undefined, undefined, undefined, undefined, undefined);
    expect(JSON.stringify(withUndef)).toBe(JSON.stringify(withoutArg));
  });
});

// ── The executor (omit / open / fold) ────────────────────────────────────────

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

describe("runSystemicChallengeExecutor", () => {
  test("a shallow ceiling writes an omitted, converged register with no host turn", () => {
    const run = runSystemicChallengeExecutor({ intent_checkpoint: checkpoint("shallow") });
    const reg = run.updated.systemic_challenge;
    if (!reg) throw new Error("systemic challenge register was not written");
    expect(reg.status).toBe("omitted");
    expect(reg.converged).toBe(true);
    expect(reg.findings).toHaveLength(0);
    expect(run.artifacts_written).toEqual(["systemic_challenge.json"]);
  });

  test("a deep ceiling with no submission OPENS the loop (metrics digest, not converged)", () => {
    const run = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    });
    const reg = run.updated.systemic_challenge;
    if (!reg) throw new Error("systemic challenge register was not written");
    expect(reg.status).toBeUndefined();
    expect(reg.converged).toBe(false);
    expect(reg.metrics).toBeDefined();
    if (!reg.metrics) throw new Error("systemic challenge metrics were not written");
    expect(reg.metrics.rollups.length).toBeGreaterThan(0);
  });

  test("folding a non-empty round keeps the loop open; an empty round converges it", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;

    const round1 = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      { findings: [mkFinding("t1", "tests", "Parallelize the release suite")] },
    ).updated.systemic_challenge;
    if (!round1) throw new Error("systemic challenge round was not written");
    expect(round1.converged).toBe(false);
    expect(round1.rounds).toHaveLength(1);
    expect(round1.findings).toHaveLength(1);

    const round2 = runSystemicChallengeExecutor(
      {
        ...opened,
        systemic_challenge: round1,
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
      },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!round2) throw new Error("systemic challenge round was not written");
    // A round that surfaced nothing new converges the loop (loop-until-dry).
    expect(round2.converged).toBe(true);
    expect(round2.rounds).toHaveLength(2);
    expect(round2.rounds[1].dry).toBe(true);
  });
});

// ── The prompt (mandate framing) ─────────────────────────────────────────────

describe("renderSecondOrderAdversaryPrompt", () => {
  test("frames the optimization/better-way mandate + loop-until-dry, not defect-finding", () => {
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      priorFindingCount: 0,
      metrics: aggregateMetricsDigest({ repo_manifest: repoManifest }),
      submissionPath: "/x/incoming/systemic-challenge.json",
    });
    expect(prompt).toMatch(/optimization/i);
    expect(prompt).toMatch(/redundant/i);
    expect(prompt).toMatch(/serial that could be parallel/i);
    expect(prompt).toMatch(/loop-until-dry|nothing new/i);
    expect(prompt).toMatch(/true lens/i);
    // The metrics are flagged as supporting-but-not-sufficient evidence.
    expect(prompt).toMatch(/necessary, NOT sufficient/i);
    // The lane is advance-free — a 2026-07-16 systemic_challenge worker
    // followed an embedded next-step command and advanced the loop itself;
    // the always-materialized fan-out (2625563f) removed the command from
    // lane prompts. Mirror of the charter pin in
    // charter-extraction-executor.test.ts.
    expect(prompt).not.toContain("next-step");
  });
});

// ── The PRIORITY insertion position ──────────────────────────────────────────

describe("PRIORITY insertion", () => {
  test("systemic_challenge_current sits immediately after charter_clarification and before planning", () => {
    const clar = PRIORITY.indexOf("charter_clarification_current");
    const systemic = PRIORITY.indexOf("systemic_challenge_current");
    const planning = PRIORITY.indexOf("planning_artifacts");
    expect(systemic).toBe(clar + 1);
    expect(planning).toBe(systemic + 1);
  });
});
