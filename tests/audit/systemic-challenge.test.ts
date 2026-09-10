import { describe, test, expect } from "vitest";

// Phase E — the systemic improvement-seeking challenge loop. Import the pure module
// + the executor from source (tsx loader) so un-rebuilt changes are caught.
import { aggregateMetricsDigest } from "../../src/audit/systemic/aggregateMetricsDigest.js";
import {
  SYSTEMIC_FINDING_ID_PREFIX,
  SYSTEMIC_ROUND_CEILING,
  foldChallengeRound,
} from "../../src/audit/systemic/systemicChallengeLoop.js";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import {
  buildReviewFileMap,
  renderReviewFileMap,
} from "../../src/audit/systemic/reviewFileMap.js";
// Through the published subpath, not the source path: importing the source
// module gives this file a SECOND `Finding` identity and the two are unrelated
// to the typechecker.
import { SystemicChallengeSubmissionSchema } from "audit-tools/shared";
import { runSystemicChallengeExecutor } from "../../src/audit/orchestrator/systemicChallengeExecutor.js";
import { mergeFindings } from "../../src/audit/reporting/mergeFindings.js";
import { PRIORITY } from "../../src/audit/orchestrator/nextStep.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { ExecutorRunResult } from "../../src/audit/orchestrator/executorResult.js";
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

/**
 * `symbol` is the structural anchor the finding names — the same field a real
 * submission carries on its affected files, and the one the restatement bar's
 * anchor requirement reads. A fixture that omits it is a finding that names no
 * code entity, which is what an id-derived evidence token amounts to: facts
 * about the finding, not about the repository.
 */
const mkFinding = (
  id: string,
  lens: string,
  title: string,
  files: string[] = ["src/a.ts"],
  symbol?: string,
): Finding => ({
  id,
  title,
  category: "systemic_improvement",
  severity: "medium",
  confidence: "medium",
  lens,
  summary: `improve ${id}`,
  // Evidence is REQUIRED of this lane (SystemicChallengeSubmissionSchema), so a
  // fixture without it is not a submission the pipeline could ever receive. A
  // fixture must meet the contract it stands in for, or it tests a shape that
  // cannot occur.
  evidence: [`\`${id}Handler\` in ${files[0] ?? "src/a.ts"} does the work serially`],
  affected_files: files.map((path) => ({ path, ...(symbol ? { symbol } : {}) })),
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
      round: 1,
      prior: [],
      submitted: [
        mkFinding("t1", "tests", "Parallelize the release suite"),
        mkFinding("o1", "operability", "Collapse the duplicated deploy step"),
      ],
      repoManifest,
    });
    const lensByTitle = Object.fromEntries(folded.findings.map((f) => [f.title, f.lens]));
    expect(lensByTitle["Parallelize the release suite"]).toBe("tests");
    expect(lensByTitle["Collapse the duplicated deploy step"]).toBe("operability");
    expect(folded.findings.every((f) => f.systemic === true)).toBe(true);
  });

  test("a round that adds nothing new is DRY (loop-until-dry terminator)", () => {
    const prior = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    }).findings;
    // Re-submit the SAME finding (same lens+category+title) → nothing new → dry.
    const again = foldChallengeRound({
      round: 2,
      prior,
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    });
    expect(again.new_finding_ids).toHaveLength(0);
    expect(again.dry).toBe(true);
  });

  test("a round that adds a NEW improvement is not dry", () => {
    const prior = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [mkFinding("t1", "tests", "Parallelize the release suite")],
      repoManifest,
    }).findings;
    const next = foldChallengeRound({
      round: 2,
      prior,
      submitted: [mkFinding("p1", "performance", "Cache the recomputed index")],
      repoManifest,
    });
    expect(next.new_finding_ids).toEqual([`${SYSTEMIC_FINDING_ID_PREFIX}2-p1`]);
    expect(next.dry).toBe(false);
    // Both findings survive, blast-ordered then id-ordered, each in its own
    // round's namespace — round 2's id cannot be round 1's.
    expect(next.findings.map((f) => f.id).sort()).toEqual([
      `${SYSTEMIC_FINDING_ID_PREFIX}1-t1`,
      `${SYSTEMIC_FINDING_ID_PREFIX}2-p1`,
    ]);
  });

  test("an empty submission is trivially dry (converges immediately)", () => {
    const folded = foldChallengeRound({ round: 1, prior: [], submitted: [], repoManifest });
    expect(folded.dry).toBe(true);
    expect(folded.new_finding_ids).toHaveLength(0);
  });

  test("an ungrounded improvement (no real component) is dropped, not surfaced", () => {
    const folded = foldChallengeRound({
      round: 1,
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
      round: 1,
      prior: [],
      submitted: [mkFinding("g1", "architecture", "Rework subsystem")],
      goalGraph,
      repoManifest,
      goalNodeOf: () => "leaf",
    });
    // leaf → {telos} = blast radius 1.
    expect(folded.findings[0].blast_radius).toBe(1);
  });

  // ── Content-based convergence + round-namespaced ids ───────────────────────

  test("a RE-WORDED restatement of a banked improvement is not new (content, not id)", () => {
    const prior = foldChallengeRound({
      round: 1,
      prior: [],
      // Both sides name the same symbol: that is what makes this a restatement
      // of ONE improvement rather than two. The restatement bar requires the
      // agreement when the titles diverge (see the "writes"/"reads" tests
      // below) — a real re-raising round reaches for the same code entity, as
      // round 3 of the 2026-08-21 lap did when it re-raised round 2's item.
      submitted: [
        mkFinding("t1", "tests", "Parallelize the release suite", ["src/a.ts"], "releaseSuite"),
      ],
      repoManifest,
    }).findings;

    // The SAME improvement under a fresh adversary id, with the title re-worded
    // — the exact shape that kept the 2026-08-21 loop open for rounds 3 and 4.
    // Convergence used to rest on `lens|category|title` equality, so a paraphrase
    // registered as new work forever.
    const again = foldChallengeRound({
      round: 2,
      prior,
      submitted: [
        mkFinding(
          "r4-sc-001",
          "tests",
          "Parallelize the release suite fully",
          ["src/a.ts"],
          "releaseSuite",
        ),
      ],
      repoManifest,
    });

    expect(again.new_finding_ids).toHaveLength(0);
    expect(again.dry).toBe(true);
    // Folded into the banked finding, not duplicated beside it: the round's
    // verification effort is kept, its id is not.
    expect(again.findings).toHaveLength(1);
    expect(again.findings[0].id).toBe(`${SYSTEMIC_FINDING_ID_PREFIX}1-t1`);
  });

  test("two improvements in ONE file that differ in the verb are not a restatement", () => {
    // The measured false positive this bar is raised for. "Batch the graph edge
    // writes" and "Batch the graph edge reads" are different improvements about
    // the same file — and Jaccard cannot see it: the two titles score 0.667,
    // above the floor the bar used to sit at, so the second was folded away as a
    // "refinement" of the first, the round was recorded QUIET, and the survivor's
    // id and title won outright. The one token that differs is the improvement.
    const prior = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [mkFinding("w1", "performance", "Batch the graph edge writes")],
      repoManifest,
    }).findings;

    const again = foldChallengeRound({
      round: 2,
      prior,
      submitted: [mkFinding("r1", "performance", "Batch the graph edge reads")],
      repoManifest,
    });

    expect(again.new_finding_ids).toHaveLength(1);
    expect(again.dry).toBe(false);
    // Both improvements survive, each addressable under its own title — the
    // absorbed copy would have left the second one as evidence under the first.
    expect(again.findings.map((f) => f.title).sort()).toEqual([
      "Batch the graph edge reads",
      "Batch the graph edge writes",
    ]);
  });

  test("a reworded rewrite of one file's improvement still needs a shared named anchor", () => {
    // The floor alone cannot carry this: padded to "… into one call" the two
    // titles score 0.778 — above the raised sameCategory floor of 0.75 — so what
    // refuses the match is the anchor requirement, not the ratio. Neither side
    // names a symbol (and each cites only its own id-derived evidence token), so
    // nothing in either finding says they are the same improvement.
    const prior = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [
        mkFinding("w1", "performance", "Batch the graph edge writes into one call"),
      ],
      repoManifest,
    }).findings;

    const again = foldChallengeRound({
      round: 2,
      prior,
      submitted: [
        mkFinding("r1", "performance", "Batch the graph edge reads into one call"),
      ],
      repoManifest,
    });

    expect(again.new_finding_ids).toHaveLength(1);
    expect(again.dry).toBe(false);
  });

  test("two DISTINCT improvements sharing boilerplate wording are not collapsed", () => {
    // The false-positive side of the restatement bar, and the reason its floors
    // are high. Jaccard counts shared tokens with no notion of which carry
    // meaning, so two unrelated improvements that happen to share a phrasing
    // scaffold score deceptively high (these two: 0.5). A match here would fold
    // real work away as a "refinement" and quiet a round that genuinely advanced
    // — a higher cost than missing a paraphrase, so the bar errs high.
    const folded = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [
        mkFinding("a", "performance", "Improvement number one"),
        mkFinding("b", "performance", "Improvement number two"),
      ],
      repoManifest,
    });
    expect(folded.new_finding_ids).toHaveLength(2);
    expect(folded.dry).toBe(false);
  });

  test("rounds 3 and 4 cannot collide on an adversary-minted id", () => {
    const round1 = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [mkFinding("SC-001", "tests", "Parallelize the release suite")],
      repoManifest,
    }).findings;
    const round2 = foldChallengeRound({
      round: 2,
      prior: round1,
      submitted: [
        // Same adversary id, a genuinely different improvement — the
        // 2026-08-08 collision, where SC-001..004 named four different findings
        // in round 4 than they had in round 3.
        mkFinding("SC-001", "performance", "Cache the recomputed index"),
      ],
      repoManifest,
    });

    const ids = round2.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`${SYSTEMIC_FINDING_ID_PREFIX}1-sc-001`);
    expect(ids).toContain(`${SYSTEMIC_FINDING_ID_PREFIX}2-sc-001`);
  });

  test("one submission repeating its OWN id still leaves both findings addressable", () => {
    const folded = foldChallengeRound({
      round: 1,
      prior: [],
      submitted: [
        mkFinding("dup", "tests", "Parallelize the release suite"),
        mkFinding("dup", "performance", "Cache the recomputed index"),
      ],
      repoManifest,
    });
    expect(folded.new_finding_ids).toHaveLength(2);
    expect(new Set(folded.findings.map((f) => f.id)).size).toBe(2);
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

  test("one quiet round does NOT converge; two consecutive quiet rounds do", () => {
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

    // First quiet round: dry, but NOT converged — the rule requires two
    // CONSECUTIVE quiet rounds (a single duplicate submission must not be able
    // to terminate the adversary loop).
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
    expect(round2.rounds).toHaveLength(2);
    expect(round2.rounds[1].dry).toBe(true);
    expect(round2.converged).toBe(false);
    expect(round2.convergence_rule).toEqual({
      quiet_rounds_required: 2,
      round_ceiling: SYSTEMIC_ROUND_CEILING,
    });

    // Second consecutive quiet round: converged.
    const round3 = runSystemicChallengeExecutor(
      {
        ...opened,
        systemic_challenge: round2,
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
      },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!round3) throw new Error("systemic challenge round was not written");
    expect(round3.rounds).toHaveLength(3);
    expect(round3.converged).toBe(true);
  });

  test("a finding between two quiet rounds resets the consecutive count", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;

    const quiet1 = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!quiet1) throw new Error("round was not written");
    expect(quiet1.converged).toBe(false);

    const busy = runSystemicChallengeExecutor(
      {
        ...opened,
        systemic_challenge: quiet1,
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
      },
      { findings: [mkFinding("t2", "performance", "Batch the graph writes")] },
    ).updated.systemic_challenge;
    if (!busy) throw new Error("round was not written");
    expect(busy.converged).toBe(false);

    // Quiet again — but the busy round broke the streak, so still one quiet
    // round, not two consecutive.
    const quiet2 = runSystemicChallengeExecutor(
      {
        ...opened,
        systemic_challenge: busy,
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
      },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!quiet2) throw new Error("round was not written");
    expect(quiet2.rounds.map((r) => r.dry)).toEqual([true, false, true]);
    expect(quiet2.converged).toBe(false);
  });

  // ── The ceiling: the loop ends without a false dry signal ──────────────────

  /**
   * The distinct improvements a busy round carries, one per round. Deliberately
   * worded apart: a fixture built from near-identical titles would be collapsed
   * by the restatement bar, and this helper's callers would then pass for a
   * reason that has nothing to do with the ceiling they are testing.
   */
  const BUSY_TITLES = [
    "Batch the graph edge writes",
    "Reuse the parsed manifest across analyzer passes",
    "Drop the second traversal of the import graph",
    "Share one content-hash cache between the extractors",
    "Collapse the duplicated ignore-rule evaluation",
    "Stream the results sink instead of buffering it",
    "Hoist the repeated path normalization",
  ] as const;

  /** Open a deep loop, then fold `count` consecutive NON-dry rounds into it. */
  function foldBusyRounds(count: number): ArtifactBundle {
    let bundle: ArtifactBundle = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated as ArtifactBundle;
    for (let index = 0; index < count; index += 1) {
      const run: ExecutorRunResult = runSystemicChallengeExecutor(
        { ...bundle, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
        {
          findings: [
            mkFinding(`f${index}`, "performance", BUSY_TITLES[index]!, [
              "src/a.ts",
              "src/b.ts",
            ]),
          ],
        },
      );
      bundle = run.updated as ArtifactBundle;
    }
    return bundle;
  }

  test("the loop ends at the round ceiling, recorded as a ceiling — not a dry round", () => {
    const bundle = foldBusyRounds(SYSTEMIC_ROUND_CEILING);
    const reg = bundle.systemic_challenge;
    if (!reg) throw new Error("the loop was never opened");

    expect(reg.rounds).toHaveLength(SYSTEMIC_ROUND_CEILING);
    // The last round found something new — it is NOT dry, and nothing about the
    // stop may report it as one. That fabrication is exactly what the ceiling
    // exists to remove.
    expect(reg.rounds.at(-1)?.dry).toBe(false);
    expect(reg.converged).toBe(true);
    expect(reg.stop_reason).toBe("round_ceiling");
    expect(reg.convergence_rule).toEqual({
      quiet_rounds_required: 2,
      round_ceiling: SYSTEMIC_ROUND_CEILING,
    });
  });

  test("a ceiling round that IS the second consecutive quiet one converges, not ceilings", () => {
    // 4 productive rounds then 2 quiet ones: the loop ended on a DEMONSTRATED
    // dry signal, in the same round that happens to reach the ceiling. Reporting
    // it as a budget stop is not a conservative wording — the ceiling's own note
    // ("the loop ends here, not on a demonstrated dry signal") is then saying
    // something false about why the loop ended.
    let bundle: ArtifactBundle = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated as ArtifactBundle;
    const submit = (findings: Finding[]): void => {
      bundle = runSystemicChallengeExecutor(
        { ...bundle, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
        { findings },
      ).updated as ArtifactBundle;
    };
    // SYSTEMIC_ROUND_CEILING (6) rounds in total: four that deliver an
    // improvement, then two quiet ones.
    for (let index = 0; index < SYSTEMIC_ROUND_CEILING - 2; index += 1) {
      submit([mkFinding(`f${index}`, "performance", BUSY_TITLES[index]!, ["src/a.ts", "src/b.ts"])]);
    }
    submit([]);
    submit([]);

    const reg = bundle.systemic_challenge;
    if (!reg) throw new Error("the loop was never opened");
    expect(reg.rounds).toHaveLength(SYSTEMIC_ROUND_CEILING);
    expect(reg.rounds.slice(-2).every((round) => round.dry)).toBe(true);
    expect(reg.converged).toBe(true);
    expect(reg.stop_reason).toBe("converged");
    expect(bundle.systemic_challenge?.stop_reason).not.toBe("round_ceiling");
  });

  test("the convergence summary says what converged and does not mention the ceiling", () => {
    let bundle: ArtifactBundle = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated as ArtifactBundle;
    const fold = (findings: Finding[]): ExecutorRunResult => {
      const run = runSystemicChallengeExecutor(
        { ...bundle, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
        { findings },
      );
      bundle = run.updated as ArtifactBundle;
      return run;
    };
    for (let index = 0; index < SYSTEMIC_ROUND_CEILING - 2; index += 1) {
      fold([
        mkFinding(`f${index}`, "performance", BUSY_TITLES[index]!, ["src/a.ts", "src/b.ts"]),
      ]);
    }
    fold([]);
    // The round that CONVERGED is also the round that reached the ceiling. Its
    // summary is the surface an operator reads without opening the artifact, and
    // it must not announce a ceiling that did not decide the ending — the
    // ceiling wording asserts the loop did NOT end on a dry signal, which here
    // is exactly backwards.
    const summary = fold([]).progress_summary;
    expect(summary).toMatch(/converged/i);
    expect(summary).not.toMatch(/ceiling/i);
  });

  test("the loop is OPEN one round below the ceiling", () => {
    const reg = foldBusyRounds(SYSTEMIC_ROUND_CEILING - 1).systemic_challenge;
    if (!reg) throw new Error("the loop was never opened");
    expect(reg.converged).toBe(false);
    expect(reg.stop_reason).toBeUndefined();
  });

  test("a recorded host-forced stop ends the loop and is not reported as convergence", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;
    const reg = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      {
        findings: [mkFinding("t1", "tests", "Parallelize the release suite")],
        stop: { forced: true, reason: "adversary budget exhausted" },
      },
    ).updated.systemic_challenge;
    if (!reg) throw new Error("round was not written");

    expect(reg.converged).toBe(true);
    expect(reg.stop_reason).toBe("host_forced");
    expect(reg.rounds.at(-1)?.dry).toBe(false);
    // The work delivered WITH the stop is banked, never discarded.
    expect(reg.findings).toHaveLength(1);
  });

  test("a dry round after a host-forced stop does not silently re-open the loop", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;
    const stopped = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      { findings: [], stop: { forced: true, reason: "budget exhausted" } },
    ).updated;
    const after = runSystemicChallengeExecutor(
      { ...stopped, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!after) throw new Error("round was not written");
    expect(after.converged).toBe(true);
    expect(after.stop_reason).toBe("host_forced");
    expect(after.stop_reason).not.toBe("converged");
  });

  test("after a host-forced stop, the progress summary does not claim convergence the register denies", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;
    // A forced stop that DELIVERED an improvement — so only one of the two rounds
    // is dry. The summary is the surface an operator reads without opening the
    // artifact, and it must not report the consecutive-quiet convergence that the
    // register's own `stop_reason` says never happened.
    const stopped = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      {
        findings: [mkFinding("t1", "tests", "Parallelize the release suite")],
        stop: { forced: true, reason: "adversary budget exhausted" },
      },
    ).updated;
    const after = runSystemicChallengeExecutor(
      { ...stopped, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      { findings: [] },
    );

    expect(after.updated.systemic_challenge?.stop_reason).toBe("host_forced");
    expect(after.progress_summary).not.toMatch(/converged/i);
    expect(after.progress_summary).toMatch(/host-forced/i);
  });

  test("a re-worded restatement across rounds reads as quiet at the executor level too", () => {
    const opened = runSystemicChallengeExecutor({
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated;
    // Both rounds cite the SAME symbol: the re-raising round reaches for the
    // same code entity, which is what makes the re-wording a restatement of one
    // improvement rather than a second one about the same file.
    const round1 = runSystemicChallengeExecutor(
      { ...opened, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      {
        findings: [
          mkFinding("SC-001", "tests", "Parallelize the release suite", ["src/a.ts"], "releaseSuite"),
        ],
      },
    ).updated;
    const round2 = runSystemicChallengeExecutor(
      { ...round1, intent_checkpoint: checkpoint("deep"), repo_manifest: repoManifest },
      {
        findings: [
          mkFinding("r4-1", "tests", "Parallelize the release suite fully", ["src/a.ts"], "releaseSuite"),
        ],
      },
    ).updated.systemic_challenge;
    if (!round2) throw new Error("round was not written");
    expect(round2.rounds.map((r) => r.dry)).toEqual([false, true]);
    expect(round2.findings).toHaveLength(1);
  });

  // ── The loop belongs to a RUN, not to an artifacts directory ───────────────

  function adjudication(generatedAt: string): ArtifactBundle["conceptual_review_adjudication"] {
    return {
      schema_version: 1,
      generated_at: generatedAt,
      round_id: "round-1",
      contributors: [
        {
          contributor_id: "p1",
          role: "perspective",
          perspective: "performance",
          lane_id: "lane-p1",
          prompt_path: "/x/p1.prompt.md",
          result_path: "/x/p1.json",
        },
      ],
      candidate_dispositions: [],
      final_finding_shares: [],
      candidate_disposition_breakdown: {},
      candidate_verification_status_breakdown: {},
    };
  }

  test("the premise token ignores the adjudication's provenance stamp", () => {
    // A re-emission of the same adjudication with a new `generated_at` is the
    // SAME premise. It is hashed through the metadata manifest's canonical hash,
    // whose non-semantic table does not strip the stamp for this artifact — so
    // an unchanged adjudication re-stamped would mint a new token, open a fresh
    // loop, and drop the rounds and improvements already banked.
    const basis = {
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    };
    const first = runSystemicChallengeExecutor(
      { ...basis, conceptual_review_adjudication: adjudication("2026-01-01T00:00:00.000Z") },
      { findings: [mkFinding("t1", "performance", "Run the manifest passes concurrently")] },
    ).updated.systemic_challenge;
    if (!first) throw new Error("the loop was never opened");

    const restamped = runSystemicChallengeExecutor({
      ...basis,
      conceptual_review_adjudication: adjudication("2026-03-03T09:09:09.000Z"),
      systemic_challenge: first,
    }).updated.systemic_challenge;
    if (!restamped) throw new Error("the loop was never opened");
    expect(restamped.round_token).toBe(first.round_token);
    // The carry is the observable half: a changed token would have reset both.
    expect(restamped.rounds).toHaveLength(1);
    expect(restamped.findings).toHaveLength(1);
  });

  test("a register from a DIFFERENT premise does not carry its rounds into this run", () => {
    const firstRun = foldBusyRounds(2);
    const priorReg = firstRun.systemic_challenge;
    if (!priorReg) throw new Error("the loop was never opened");
    expect(priorReg.rounds).toHaveLength(2);
    expect(priorReg.findings).toHaveLength(2);

    // The same artifacts dir, a different repository: the premise token differs.
    const secondRun = runSystemicChallengeExecutor({
      ...firstRun,
      repo_manifest: {
        repository: { name: "another-repo", root: "/other" },
        generated_at: "2026-02-02T00:00:00.000Z",
        files: [
          { path: "src/z.ts", language: "typescript", size_bytes: 1 },
        ],
      },
      intent_checkpoint: checkpoint("deep"),
    }).updated.systemic_challenge;
    if (!secondRun) throw new Error("the loop was never opened");
    expect(secondRun.rounds).toHaveLength(0);
    expect(secondRun.findings).toHaveLength(0);
    expect(secondRun.round_token).not.toBe(priorReg.round_token);
  });

  test("a TOKEN-LESS register carries its rounds, findings and stop reason into this run", () => {
    // A register written before the premise binding existed carries NO
    // `round_token`. The migration carry is the whole point: the bundle's own
    // register is the loop's memory, and discarding it restarts a loop that had
    // banked work — the round counter falls back to 1 and every earlier
    // improvement is lost (the systemic-round-identity handler test, which
    // builds exactly this register, is the live instance).
    const legacy: SystemicChallengeRegister = {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "systemic_challenge",
      ceiling: { rung: "deep" },
      rounds: [{ round: 1, new_finding_ids: ["sc-r1-legacy"], dry: false }],
      converged: false,
      convergence_rule: { quiet_rounds_required: 2 },
      findings: [
        { ...mkFinding("sc-r1-legacy", "performance", "Run the manifest passes concurrently"), systemic: true },
      ],
      validation_issues: [],
      // NO round_token — the shape every register written before the token had.
    };
    expect(legacy.round_token).toBeUndefined();

    // (a) A submission-less run re-emits the register as-is.
    const open = runSystemicChallengeExecutor(
      {
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
        systemic_challenge: legacy,
      },
    ).updated.systemic_challenge;
    if (!open) throw new Error("the loop was never opened");
    expect(open.rounds).toHaveLength(1);
    expect(open.findings.map((f) => f.title)).toEqual([
      "Run the manifest passes concurrently",
    ]);

    // (b) A submission folds as round TWO over the carried memory — the emptied
    // round is the second, and both rounds are the register's.
    const folded = runSystemicChallengeExecutor(
      {
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
        systemic_challenge: legacy,
      },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!folded) throw new Error("the loop was never opened");
    expect(folded.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(folded.rounds.map((r) => r.dry)).toEqual([false, true]);
    expect(folded.findings).toHaveLength(1);
    expect(folded.round_token).toBeDefined();
  });

  test("a TOKEN-LESS register is a ONE-TIME carry: the ending it recorded survives too", () => {
    // The other half of the migration carry. A token-less register that already
    // ENDED on the ceiling must stay ended — carrying its rounds but dropping
    // its `stop_reason` would put the loop back in flight with five rounds
    // already spent, and the next quiet round would then re-mint the reason.
    const legacyCeiling: SystemicChallengeRegister = {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "systemic_challenge",
      ceiling: { rung: "deep" },
      rounds: [{ round: 1, new_finding_ids: ["x"], dry: false }],
      converged: true,
      stop_reason: "round_ceiling",
      findings: [],
      validation_issues: [],
    };

    const after = runSystemicChallengeExecutor(
      {
        intent_checkpoint: checkpoint("deep"),
        repo_manifest: repoManifest,
        systemic_challenge: legacyCeiling,
      },
      { findings: [] },
    ).updated.systemic_challenge;
    if (!after) throw new Error("the loop was never opened");
    expect(after.converged).toBe(true);
    expect(after.stop_reason).toBe("round_ceiling");
  });

  test("a re-emission of the SAME premise still carries its rounds (idempotence)", () => {
    const firstRun = foldBusyRounds(1);
    const again = runSystemicChallengeExecutor({
      ...firstRun,
      intent_checkpoint: checkpoint("deep"),
      repo_manifest: repoManifest,
    }).updated.systemic_challenge;
    if (!again) throw new Error("the loop was never opened");
    expect(again.rounds).toHaveLength(1);
    expect(again.findings).toHaveLength(1);
  });

  // ── The covered-themes digest the next round is handed ─────────────────────

  test("the register carries a covered-themes digest of what is banked", () => {
    const bundle = foldBusyRounds(1);
    const reg = bundle.systemic_challenge;
    if (!reg) throw new Error("the loop was never opened");
    expect(reg.covered_themes?.finding_count).toBe(1);
    expect(reg.covered_themes?.by_lens).toEqual([{ value: "performance", count: 1 }]);
    expect(reg.covered_themes?.files).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// ── The prompt (mandate framing) ─────────────────────────────────────────────

describe("renderSecondOrderAdversaryPrompt", () => {
  test("frames the optimization/better-way mandate + loop-until-dry, not defect-finding", () => {
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest({ repo_manifest: repoManifest }),
      submissionPath: "/x/incoming/systemic-challenge.json",
      bundle: { repo_manifest: repoManifest },
      evidencePaths: ["/x/charter_register.json", "/x/p1.json", "/x/judge.json"],
    });
    expect(prompt).toMatch(/optimization/i);
    expect(prompt).toMatch(/redundant/i);
    expect(prompt).toMatch(/serial that could be parallel/i);
    expect(prompt).toMatch(/loop-until-dry|nothing new/i);
    // The lane's findings are unremediatable without evidence — the remediate
    // intake filter drops a finding that carries none, recording only its id.
    // The prompt must therefore ASK for the field its own submission requires.
    expect(prompt).toMatch(/"evidence"/);
    expect(prompt).toMatch(/at least one `evidence` entry/i);
    // Symbols, not line numbers: a line number is wrong after the next edit.
    expect(prompt).toMatch(/SYMBOLS, not line numbers/);
    expect(prompt).toMatch(/true lens/i);
    // The metrics are flagged as supporting-but-not-sufficient evidence.
    expect(prompt).toMatch(/necessary, NOT sufficient/i);
    expect(prompt).toContain("/x/p1.json");
    expect(prompt).toContain("/x/judge.json");
    expect(prompt).toMatch(/callers and callees in both directions/i);
    // The lane is advance-free — a 2026-07-16 systemic_challenge worker
    // followed an embedded next-step command and advanced the loop itself;
    // the always-materialized fan-out (2625563f) removed the command from
    // lane prompts. Mirror of the charter pin in
    // charter-extraction-executor.test.ts.
    expect(prompt).not.toContain("next-step");
  });

  test("hands the adversary the banked set itself, not a count of it", () => {
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 2,
      metrics: aggregateMetricsDigest({ repo_manifest: repoManifest }),
      submissionPath: "/x/incoming/systemic-challenge.json",
      bundle: {
        repo_manifest: repoManifest,
        systemic_challenge: {
          generated_at: "2026-01-01T00:00:00.000Z",
          target: "systemic_challenge",
          ceiling: { rung: "deep" },
          rounds: [],
          converged: false,
          findings: [
            {
              ...mkFinding("sc-r1-map", "performance", "Run the graph writes concurrently"),
              systemic: true,
            },
          ],
          validation_issues: [],
        },
      },
      evidencePaths: [],
    });
    // A COUNT is not a banked set. Round 3 of the 2026-08-21 lap re-emitted round
    // 2's improvement under a fresh id; the adversary cannot avoid what it cannot
    // see, so the set is rendered in full and so is the ground it covers.
    expect(prompt).toContain("Run the graph writes concurrently");
    expect(prompt).toContain("sc-r1-map");
    expect(prompt).toMatch(/covered ground/i);
    // The variation bar: the round must name the axis it departs on.
    expect(prompt).toMatch(/departs on/i);
  });

  test("states the identity constraint to the LANE, not only to the dispatching host", () => {
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest({ repo_manifest: repoManifest }),
      submissionPath: "/x/incoming/systemic-challenge.json",
      bundle: { repo_manifest: repoManifest },
      evidencePaths: [],
    });
    // The envelope told the HOST "must NOT be the agent that drove this audit";
    // nothing in the lane prompt itself did, so an inline self-review satisfied
    // the letter and destroyed the point with no surface recording it.
    expect(prompt).toMatch(/SEPARATE agent from the one that drove this audit/i);
    expect(prompt).toMatch(/you did not author/i);
  });

  test("hands the round a provenanced, read-only call-site map it did not author", () => {
    const bundle: ArtifactBundle = {
      repo_manifest: {
        repository: { name: "map-fixture", root: "/repo" },
        generated_at: "2026-01-01T00:00:00.000Z",
        files: [
          { path: "src/a.ts", language: "typescript", size_bytes: 10 },
          { path: "src/b.ts", language: "typescript", size_bytes: 10 },
        ],
      },
      graph_bundle: {
        graphs: { imports: [{ from: "src/a.ts", to: "src/b.ts" }] },
      },
    };
    const prompt = renderSecondOrderAdversaryPrompt({
      round: 1,
      metrics: aggregateMetricsDigest(bundle),
      submissionPath: "/x/incoming/systemic-challenge.json",
      bundle,
      evidencePaths: [],
    });

    // The recon a review round must not re-derive every time (~135k subagent
    // tokens a round, 2026-07-19).
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("src/b.ts");
    expect(prompt).toMatch(/did NOT author/i);
    expect(prompt).toMatch(/read-only|cannot write back/i);
    // ...and the verdict stays the round's own: a disagreement is stated, not
    // absorbed into the map.
    expect(prompt).toMatch(/contradicts the map/i);
  });
});

// ── The call-site map the review lanes receive ───────────────────────────────

describe("buildReviewFileMap", () => {
  const mapBundle: ArtifactBundle = {
    repo_manifest: {
      repository: { name: "map-fixture", root: "/repo" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "src/b.ts", language: "typescript", size_bytes: 10 },
        { path: "src/a.ts", language: "typescript", size_bytes: 10 },
        { path: "src/isolated.ts", language: "typescript", size_bytes: 10 },
      ],
    },
    graph_bundle: {
      graphs: {
        imports: [
          { from: "src/a.ts", to: "src/b.ts" },
          { from: "src/b.ts", to: "src/a.ts" },
        ],
      },
    },
  };

  test("reads the graph in BOTH directions and orders by path, not iteration order", () => {
    const map = buildReviewFileMap(mapBundle);
    expect(map.anchors.map((anchor) => anchor.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(map.anchors[0].callees).toEqual(["src/b.ts"]);
    expect(map.anchors[0].callers).toEqual(["src/b.ts"]);
    // A file nothing connects is omitted rather than reported as a leaf — but the
    // omission is a map property, not a claim that it has no callers.
    expect(map.anchors.some((anchor) => anchor.path === "src/isolated.ts")).toBe(false);
  });

  test("states its own provenance as tool-derived", () => {
    const map = buildReviewFileMap(mapBundle);
    expect(map.provenance.author).toBe("tool");
    expect(map.provenance.edge_count).toBe(2);
    expect(map.provenance.graph_present).toBe(true);
  });

  test("STATES a cap instead of silently truncating", () => {
    const map = buildReviewFileMap(mapBundle, { maxAnchors: 1 });
    expect(map.anchors).toHaveLength(1);
    expect(map.anchors_omitted).toBe(1);
    const rendered = renderReviewFileMap(map).join("\n");
    expect(rendered).toMatch(/1 further file\(s\) with call sites are NOT listed/);
  });

  test("STATES the files the graph carries no edge for, rather than dropping them silently", () => {
    // `src/isolated.ts` is authored and edge-less. The header promises that a
    // drop is STATED; a map that quietly omits it reads as a complete one, and a
    // review round then treats an extraction gap as "nothing depends on this".
    const map = buildReviewFileMap(mapBundle);
    expect(map.files_without_edges).toBe(1);
    const rendered = renderReviewFileMap(map).join("\n");
    expect(rendered).toMatch(/1 authored file\(s\) carry no graph edge and are NOT listed/);
  });

  test("the edge-less statement accompanies the NO RECON branch too", () => {
    // The empty branch has its own wording, and the omission it now states is a
    // different one: no anchor at all was built, so EVERY authored file is
    // edge-less and the count is the manifest's file count.
    const rendered = renderReviewFileMap(
      buildReviewFileMap({ repo_manifest: mapBundle.repo_manifest }),
    ).join("\n");
    expect(rendered).toMatch(/NO\s+RECON/i);
    expect(rendered).toMatch(/3 authored file\(s\) carry no graph edge and are NOT listed/);
  });

  test("an absent graph reads as NO RECON, never as 'everything is unconnected'", () => {
    const rendered = renderReviewFileMap(
      buildReviewFileMap({ repo_manifest: mapBundle.repo_manifest }),
    ).join("\n");
    expect(rendered).toMatch(/NO\s+RECON/i);
    expect(rendered).toMatch(/not evidence that no caller exists/i);
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

// ── Evidence is required, and the refusal is the point ───────────────────────

// Before this, `SystemicChallengeSubmissionSchema` used the bare `FindingSchema`,
// whose `evidence` is optional. Every OTHER producer already meets a stricter
// rule — `schemas/audit_result.schema.json` declares `minItems: 1` on evidence
// for host submissions — so this lane was the single escape, and the remediate
// intake's filter pass silently discards a finding with no evidence. The lane
// could converge, bank improvements, and have all of them dropped downstream
// with no signal on any surface.
describe("SystemicChallengeSubmissionSchema evidence requirement", () => {
  const wellFormed = {
    id: "SYS-1",
    title: "Parallelize the serial verification legs",
    category: "systemic_improvement",
    severity: "medium",
    confidence: "high",
    lens: "performance",
    summary: "The legs are independent and run serially.",
    affected_files: [{ path: "scripts/verify.mjs" }],
  };

  test("refuses a systemic finding that carries no evidence", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [wellFormed],
    });
    expect(parsed.success).toBe(false);
  });

  test("refuses a systemic finding whose evidence array is empty", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [{ ...wellFormed, evidence: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts a systemic finding with at least one evidence entry", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [
        { ...wellFormed, evidence: ["`runVerifyLegs` in scripts/verify.mjs awaits each leg in turn"] },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  test("an empty findings array still converges the loop", () => {
    // The loop-until-dry terminator must not become collateral damage of a
    // stricter per-finding rule.
    const parsed = SystemicChallengeSubmissionSchema.safeParse({ findings: [] });
    expect(parsed.success).toBe(true);
  });

  test("accepts a host-forced stop alongside the findings it delivered", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [{ ...wellFormed, evidence: ["`f` in src/a.ts"] }],
      stop: { forced: true, reason: "adversary budget exhausted" },
    });
    expect(parsed.success).toBe(true);
  });

  test("refuses a forced stop with no reason — an unexplained stop is indistinguishable from a lost loop", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [],
      stop: { forced: true },
    });
    expect(parsed.success).toBe(false);
  });

  test("refuses an EMPTY reason — a blank string explains nothing", () => {
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [],
      stop: { forced: true, reason: "" },
    });
    expect(parsed.success).toBe(false);
  });

  test("refuses a stop object that does not actually force a stop", () => {
    // Recording a stop the host did not claim would let a round report itself
    // ended while the loop simply continued.
    const parsed = SystemicChallengeSubmissionSchema.safeParse({
      findings: [],
      stop: { forced: false, reason: "not really" },
    });
    expect(parsed.success).toBe(false);
  });
});
