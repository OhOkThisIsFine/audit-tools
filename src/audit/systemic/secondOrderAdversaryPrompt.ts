// Phase E — the SECOND-ORDER ADVERSARY prompt (host_delegation).
//
// The adversary runs as a SEPARATE agent ([[delegate-adversarial-phases-to-separate-
// agent]]) — an author marking its own homework misses the gaps. Its mandate is
// OPTIMIZATION / BETTER-WAY, not defect-finding: it must actively seek SUPERIOR
// ALTERNATIVES to things that currently WORK (the class no correctness lens flags
// because nothing is broken) — what's redundant, serial-that-could-be-parallel,
// duplicated, over-built; what assumption went unquestioned; is there a categorically
// better approach (design of record spec + backlog "Systemic reviewers must be pushed
// adversarially for improvement"). LOOP-UNTIL-DRY: this is round N of a loop that ends
// only when a round surfaces NOTHING NEW.
//
// The aggregate-metrics digest is NECESSARY supporting evidence, explicitly NOT
// SUFFICIENT alone — the adversary reasons from the whole system, using the counts as
// leads, not conclusions.

import type { AggregateMetricsDigest } from "./aggregateMetricsDigest.js";

/**
 * Render the second-order-adversary host prompt for one challenge round. `round` is
 * the 1-based loop ordinal; `priorFindingCount` orients the adversary on what already
 * surfaced (so it pushes for NEW improvements, not re-statements). `submissionPath`
 * is where the agent writes its findings; an EMPTY findings array is the deliberate
 * loop-until-dry terminator (this round found nothing new).
 */
export function renderSecondOrderAdversaryPrompt(opts: {
  round: number;
  priorFindingCount: number;
  metrics: AggregateMetricsDigest;
  submissionPath: string;
  continueCommand: string;
}): string {
  const metricLines = opts.metrics.rollups.map(
    (r) => `- ${r.label}: ${r.count} ${r.unit}`,
  );
  metricLines.push(`- Max fan-out (out-degree): ${opts.metrics.max_fan_out}`);

  return [
    "# Design review — systemic improvement-seeking challenge (second-order adversary)",
    "",
    `You are a SEPARATE second-order adversary. This is challenge round ${opts.round}.`,
    `The pass has already surfaced ${opts.priorFindingCount} improvement(s); your job is`,
    "to push HARDER and find what earlier rounds missed.",
    "",
    "## Mandate — optimization / better-way, NOT defect-finding",
    "Do NOT hunt for bugs (other lenses own that). Re-interrogate the system with",
    "human-grade pressure and seek SUPERIOR ALTERNATIVES to things that currently WORK:",
    "- What is **redundant** — done more than once, or more than needed?",
    "- What is **serial that could be parallel**?",
    "- What is **duplicated** across places that should share?",
    "- What is **over-built** — complexity with no payload?",
    "- What **assumption went unquestioned**?",
    "- Is there a **categorically better approach** to a whole subsystem?",
    "",
    "## Aggregate metrics (supporting evidence — necessary, NOT sufficient)",
    "These abstract, language-neutral counts are LEADS, not conclusions. Reason from",
    "the whole system; use them only to aim your attention:",
    ...metricLines,
    "",
    "## True lens (required)",
    "Tag each finding with its TRUE lens — a test-parallelization finding is `tests`",
    "or `performance`; an ops finding is `operability`. Do NOT default to",
    "`architecture`. The lens routes the improvement to the right place in synthesis.",
    "",
    "## Loop-until-dry",
    "The review is done only when a round yields NOTHING NEW — not when it first has an",
    "answer. If, after genuine pressure, you find no NEW improvement this round, submit",
    "an EMPTY findings array; that converges the loop. Otherwise submit the new",
    "improvements (each pointing at at least one real component).",
    "",
    "## Output",
    `Write JSON to \`${opts.submissionPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "findings": [',
    "    {",
    '      "id": "<stable id>",',
    '      "title": "<the improvement>",',
    '      "category": "systemic_improvement",',
    '      "severity": "low|medium|high",',
    '      "confidence": "low|medium|high",',
    '      "lens": "<the TRUE lens: tests|performance|operability|...>",',
    '      "summary": "<what to do and why it is better>",',
    '      "affected_files": [{ "path": "<a real repo path>" }]',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "When the submission is written, run:",
    "",
    `  ${opts.continueCommand}`,
    "",
  ].join("\n");
}
