/**
 * A-2 — the deterministic finding-quality oracle (`score-audit`).
 *
 * `scoreAudit` is a PURE function of (a fresh audit's findings, a corpus's
 * human-applied labels). It is the falsifiable measure of audit output quality:
 * precision (are emitted findings real?), recall_against_known (did this run
 * re-find the labeled true-positives?), and hallucination_rate (how many emitted
 * findings are labeled `hallucinated` — cited code that doesn't exist / says
 * otherwise, exactly what the grounding pass should have caught).
 *
 * Two design rules, both load-bearing:
 *
 * 1. **Match ONLY by `findingIdentitySignature`** — the one shared "is this the
 *    same finding?" authority. Volatile fields (line numbers, pass ordinals,
 *    reworded titles) never reach the signature, so a reworded re-emission of a
 *    labeled finding still matches its label across runs.
 * 2. **No silent scoring.** Every emitted finding and every label that cannot be
 *    cleanly matched is surfaced in `unmatched[]` with an explicit reason — it is
 *    never folded into a verdict it doesn't belong to. In particular the CE-010
 *    case (`findingIdentitySignature` is non-injective: two DISTINCT findings can
 *    share `affected_files[0].path + symbol`, e.g. tier-2 lens+category fileless
 *    collisions) is surfaced as an `ambiguous_signature_collision` group rather
 *    than scoring multiple distinct findings/labels under one verdict.
 *
 * The exit code (the CI gate) is wired SOLELY to a hallucination-rate
 * REGRESSION — see {@link hallucinationRegressed}. Precision and recall are
 * tracked and emitted but never gate the build (the A-2 "track, don't gate"
 * decision: precision/recall thresholds are flaky on legitimate finding-set
 * changes until a baseline is established; hallucination-rate is the one
 * unambiguous metric, already half-enforced by grounding).
 *
 * Pure module: no IO, no clock, no model identity — the same (findings, labels)
 * always yields a byte-identical scorecard.
 */

import { findingIdentityKey, type Finding } from "audit-tools/shared";

/** The label a human applies to one finding of a labeled corpus run. */
export type FindingLabel = "true_positive" | "false_positive" | "hallucinated";

/**
 * One human-applied label, keyed on a finding-identity SIGNATURE (not a finding
 * id — ids are run-local and content-addressed; the signature is the stable
 * cross-run identity). `note` is optional human context, ignored by scoring.
 */
export interface CorpusLabel {
  /** The `findingIdentitySignature` of the labeled finding. */
  signature: string;
  label: FindingLabel;
  /** Optional human note (e.g. why it was deemed hallucinated). Not scored. */
  note?: string;
}

/**
 * A versioned corpus labels file (`corpus/<run-id>.labels.json`). Decoupled from
 * the raw run so a re-run of the auditor can be scored against the SAME labels.
 */
export interface CorpusLabels {
  schema_version: "score-audit-corpus-labels/v1";
  /** The run these labels were applied to (provenance only; not scored). */
  run_id: string;
  labels: CorpusLabel[];
}

/** Why a finding or a label could not be cleanly scored. */
export type UnmatchedReason =
  /** An emitted finding whose signature has no label in the corpus. */
  | "finding_unlabeled"
  /** A label whose signature was not emitted by this run (recall miss bucket). */
  | "label_unmatched"
  /**
   * CE-010: a signature shared by MORE THAN ONE distinct emitted finding and/or
   * more than one label — non-injective identity. Surfaced, never scored under a
   * single verdict.
   */
  | "ambiguous_signature_collision";

/** One entry in the explicit, no-silent-scoring `unmatched[]` accounting. */
export interface UnmatchedEntry {
  signature: string;
  reason: UnmatchedReason;
  /** Ids of the emitted finding(s) at this signature (stable order). */
  finding_ids: string[];
  /** Labels recorded at this signature (stable order). */
  labels: FindingLabel[];
}

/** The deterministic scorecard `scoreAudit` emits. */
export interface Scorecard {
  schema_version: "score-audit-scorecard/v1";
  run_id: string;
  counts: {
    /** Findings emitted by the run (the scorer's input finding set). */
    findings_emitted: number;
    /** Labels in the corpus. */
    labels_total: number;
    /** Findings cleanly matched 1:1 to a label by signature. */
    matched: number;
    /** Of matched, labeled `true_positive`. */
    true_positives: number;
    /** Of matched, labeled `false_positive`. */
    false_positives: number;
    /** Of matched, labeled `hallucinated`. */
    hallucinated: number;
    /** Labeled true_positives NOT re-found by this run (recall misses). */
    known_true_positives_missed: number;
    /** Total entries in `unmatched[]` (collisions + unlabeled + label misses). */
    unmatched: number;
    /** Of `unmatched`, the CE-010 collision groups. */
    collisions: number;
  };
  /**
   * precision = TP / (TP + FP + hallucinated) over CLEANLY-MATCHED findings.
   * `null` when there are no matched findings (undefined, never silently 0).
   */
  precision: number | null;
  /**
   * recall_against_known = (labeled TP re-found) / (all labeled TP). `null` when
   * the corpus labels no true_positives. Recall-against-KNOWN, not absolute.
   */
  recall_against_known: number | null;
  /**
   * hallucination_rate = hallucinated / findings_emitted. The gated metric.
   * `null` when the run emitted no findings (undefined, never silently 0).
   */
  hallucination_rate: number | null;
  /** Explicit accounting of everything not cleanly scored (no silent scoring). */
  unmatched: UnmatchedEntry[];
}

/**
 * The signature of a finding — the single match key (CE-010 axis). Delegates to
 * the pipeline's one finding-identity authority (`findingIdentityKey`); it is NOT
 * re-derived here, so the scorer can never drift from the auditor's own
 * "is this the same finding?" rule.
 */
export function findingSignature(finding: Finding): string {
  return findingIdentityKey(finding);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Score a fresh audit's findings against a corpus's labels — the pure A-2 oracle.
 *
 * Matching is by `findingIdentitySignature` ONLY. A signature carrying more than
 * one distinct emitted finding OR more than one label is non-injective (CE-010);
 * it is surfaced as an `ambiguous_signature_collision` and excluded from every
 * verdict — neither finding nor label at a colliding signature is scored.
 *
 * Cleanly matched (exactly one finding ↔ exactly one label) drives precision /
 * hallucination_rate; the labeled true_positive set drives recall_against_known.
 * Emitted findings with no label, and labels not re-found by the run, are each
 * surfaced in `unmatched[]` (no silent scoring).
 */
export function scoreAudit(
  findings: Finding[],
  corpus: CorpusLabels,
): Scorecard {
  // Group emitted findings by signature (stable id order within a group).
  const findingsBySig = new Map<string, string[]>();
  for (const finding of findings) {
    const sig = findingSignature(finding);
    const ids = findingsBySig.get(sig) ?? [];
    ids.push(finding.id);
    findingsBySig.set(sig, ids);
  }
  for (const ids of findingsBySig.values()) ids.sort();

  // Group labels by signature (stable label order within a group).
  const labelsBySig = new Map<string, FindingLabel[]>();
  for (const entry of corpus.labels) {
    const labels = labelsBySig.get(entry.signature) ?? [];
    labels.push(entry.label);
    labelsBySig.set(entry.signature, labels);
  }
  for (const labels of labelsBySig.values()) labels.sort();

  // The universe of signatures, iterated in a deterministic (sorted) order so
  // the scorecard is byte-identical across runs regardless of input ordering.
  const allSignatures = [
    ...new Set([...findingsBySig.keys(), ...labelsBySig.keys()]),
  ].sort();

  let truePositives = 0;
  let falsePositives = 0;
  let hallucinated = 0;
  let matched = 0;
  let knownTpMissed = 0;
  const unmatched: UnmatchedEntry[] = [];

  // Recall denominator: every labeled true_positive in the corpus. A signature
  // is only counted as RE-FOUND when it cleanly matches (no collision).
  let knownTpTotal = 0;
  for (const labels of labelsBySig.values()) {
    knownTpTotal += labels.filter((l) => l === "true_positive").length;
  }

  for (const sig of allSignatures) {
    const findingIds = findingsBySig.get(sig) ?? [];
    const labels = labelsBySig.get(sig) ?? [];

    // CE-010: non-injective signature. More than one distinct finding OR more
    // than one label at this signature → cannot attribute a single verdict.
    // Surface as a collision; score NOTHING here.
    if (findingIds.length > 1 || labels.length > 1) {
      unmatched.push({
        signature: sig,
        reason: "ambiguous_signature_collision",
        finding_ids: findingIds,
        labels,
      });
      // A colliding signature whose labels include true_positives is NOT counted
      // as re-found (we cannot prove which finding satisfied which label).
      knownTpMissed += labels.filter((l) => l === "true_positive").length;
      continue;
    }

    // Exactly one finding and exactly one label → a clean 1:1 match.
    if (findingIds.length === 1 && labels.length === 1) {
      matched += 1;
      const label = labels[0];
      if (label === "true_positive") truePositives += 1;
      else if (label === "false_positive") falsePositives += 1;
      else hallucinated += 1;
      continue;
    }

    // A finding with no label — surfaced, never scored.
    if (findingIds.length === 1 && labels.length === 0) {
      unmatched.push({
        signature: sig,
        reason: "finding_unlabeled",
        finding_ids: findingIds,
        labels: [],
      });
      continue;
    }

    // A label not re-found by this run — a recall miss bucket, surfaced.
    if (findingIds.length === 0 && labels.length === 1) {
      unmatched.push({
        signature: sig,
        reason: "label_unmatched",
        finding_ids: [],
        labels,
      });
      knownTpMissed += labels.filter((l) => l === "true_positive").length;
      continue;
    }
  }

  const findingsEmitted = findings.length;
  const collisions = unmatched.filter(
    (u) => u.reason === "ambiguous_signature_collision",
  ).length;

  return {
    schema_version: "score-audit-scorecard/v1",
    run_id: corpus.run_id,
    counts: {
      findings_emitted: findingsEmitted,
      labels_total: corpus.labels.length,
      matched,
      true_positives: truePositives,
      false_positives: falsePositives,
      hallucinated,
      known_true_positives_missed: knownTpMissed,
      unmatched: unmatched.length,
      collisions,
    },
    // precision over cleanly-matched findings only.
    precision: ratio(truePositives, truePositives + falsePositives + hallucinated),
    recall_against_known: ratio(knownTpTotal - knownTpMissed, knownTpTotal),
    hallucination_rate: ratio(hallucinated, findingsEmitted),
    unmatched,
  };
}

/**
 * The SOLE gate predicate: did the hallucination rate REGRESS against a baseline?
 *
 * The CI exit code is wired to this and nothing else (A-2 track-don't-gate).
 * Precision/recall are emitted for tracking but never gate the build.
 *
 * - With no baseline, nothing has regressed (the first run establishes the
 *   baseline — it cannot regress against itself).
 * - A `null` current rate (the run emitted no findings) cannot regress.
 * - A `null` baseline rate (the baseline emitted no findings) is treated as 0 —
 *   any positive current rate is then a regression.
 *
 * `epsilon` absorbs floating-point noise so a byte-identical re-run never trips.
 */
export function hallucinationRegressed(
  current: Scorecard,
  baseline: Scorecard | null | undefined,
  epsilon = 1e-9,
): boolean {
  if (!baseline) return false;
  const currentRate = current.hallucination_rate;
  if (currentRate === null) return false;
  const baselineRate = baseline.hallucination_rate ?? 0;
  return currentRate > baselineRate + epsilon;
}

/** A compact, deterministic human summary of a {@link Scorecard}. */
export function renderScorecardMarkdown(scorecard: Scorecard): string {
  const pct = (value: number | null): string =>
    value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const c = scorecard.counts;
  const lines = [
    `# Audit scorecard — ${scorecard.run_id}`,
    "",
    `- Findings emitted: ${c.findings_emitted}`,
    `- Labels: ${c.labels_total}`,
    `- Matched (1:1 by signature): ${c.matched} ` +
      `(TP ${c.true_positives}, FP ${c.false_positives}, hallucinated ${c.hallucinated})`,
    `- Precision: ${pct(scorecard.precision)}`,
    `- Recall against known: ${pct(scorecard.recall_against_known)} ` +
      `(${c.known_true_positives_missed} known TP missed)`,
    `- Hallucination rate (gated): ${pct(scorecard.hallucination_rate)}`,
    `- Unmatched: ${c.unmatched} ` +
      `(of which ${c.collisions} ambiguous signature collision(s))`,
  ];
  if (scorecard.unmatched.length > 0) {
    lines.push("", "## Unmatched (not scored)");
    for (const entry of scorecard.unmatched) {
      const ids = entry.finding_ids.length > 0 ? entry.finding_ids.join(", ") : "—";
      const labels = entry.labels.length > 0 ? entry.labels.join(", ") : "—";
      lines.push(`- \`${entry.signature}\` — ${entry.reason}: findings [${ids}], labels [${labels}]`);
    }
  }
  return lines.join("\n") + "\n";
}
