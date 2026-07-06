import { describe, test, expect } from "vitest";

// Phase E — the systemic improvement-seeking challenge loop. Import the pure module
// + the executor from source (tsx loader) so un-rebuilt changes are caught.
import { aggregateMetricsDigest } from "../../src/audit/systemic/aggregateMetricsDigest.ts";
import {
  foldChallengeRound,
  SYSTEMIC_HIGH_BLAST_THRESHOLD,
} from "../../src/audit/systemic/systemicChallengeLoop.ts";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.ts";
import { runSystemicChallengeExecutor } from "../../src/audit/orchestrator/systemicChallengeExecutor.ts";
import { mergeFindings } from "../../src/audit/reporting/mergeFindings.ts";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.ts";
import { DEFAULT_RISK_GATE_THRESHOLDS } from "../../src/audit/clarification/riskGate.ts";

// ── The aggregate-metrics digest (language-neutral) ──────────────────────────

describe("aggregateMetricsDigest", () => {
  test("derives language-neutral abstract counts from the bundle", () => {
    const digest = aggregateMetricsDigest({
      repo_manifest: { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
      unit_manifest: { units: [{}, {}, {}] },
      structure_decomposition: { consensus: [{}], contested: [{}, {}] },
      audit_tasks: [{}, {}, {}, {}],
      graph_bundle: {
        graphs: {
          imports: [
            { from: "a", to: "b" },
            { from: "a", to: "c" },
            { from: "b", to: "c" },
          ],
        },
      },
    });
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

const mkFinding = (id, lens, title, files = ["src/a.ts"]) => ({
  id,
  title,
  category: "systemic_improvement",
  severity: "medium",
  confidence: "medium",
  lens,
  summary: `improve ${id}`,
  affected_files: files.map((path) => ({ path })),
});

const repoManifest = { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] };

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
    const goalGraph = {
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

  test("the high-blast threshold is single-sourced from the Phase D risk gate", () => {
    expect(SYSTEMIC_HIGH_BLAST_THRESHOLD).toBe(
      DEFAULT_RISK_GATE_THRESHOLDS.highBlastThreshold,
    );
  });
});

// ── The mergeFindings true-lens seam ─────────────────────────────────────────

describe("mergeFindings systemic true-lens seam", () => {
  test("systemic findings enter with their TRUE lens, not collapsed into architecture", () => {
    const systemicChallenge = {
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

describe("runSystemicChallengeExecutor", () => {
  test("a shallow ceiling writes an omitted, converged register with no host turn", () => {
    const run = runSystemicChallengeExecutor({ intent_checkpoint: checkpoint("shallow") });
    const reg = run.updated.systemic_challenge;
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
    expect(reg.status).toBeUndefined();
    expect(reg.converged).toBe(false);
    expect(reg.metrics).toBeDefined();
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
      continueCommand: "audit-code next-step",
    });
    expect(prompt).toMatch(/optimization/i);
    expect(prompt).toMatch(/redundant/i);
    expect(prompt).toMatch(/serial that could be parallel/i);
    expect(prompt).toMatch(/loop-until-dry|nothing new/i);
    expect(prompt).toMatch(/true lens/i);
    // The metrics are flagged as supporting-but-not-sufficient evidence.
    expect(prompt).toMatch(/necessary, NOT sufficient/i);
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
