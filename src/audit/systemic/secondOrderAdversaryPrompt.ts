// Phase E — SECOND-ORDER ADVERSARY prompt (host_delegation).
//
// The adversary is a SEPARATE agent and receives the evidence the earlier
// design-review contributors actually produced. Aggregate metrics remain leads,
// never a substitute for charters, candidate dispositions, prior findings, and
// direct repository/source verification.

import type { ArtifactBundle } from "../io/artifacts.js";
import type { Finding } from "../types.js";
import type { AggregateMetricsDigest } from "./aggregateMetricsDigest.js";

function priorFindings(bundle: ArtifactBundle): Finding[] {
  const candidates = [
    ...(bundle.design_assessment?.contract_findings ?? []),
    ...(bundle.design_assessment?.conceptual_findings ?? []),
    ...(bundle.charter_register?.findings ?? []),
    ...(bundle.systemic_challenge?.findings ?? []),
  ];
  const seen = new Set<string>();
  return candidates.filter((finding) => {
    const key = `${finding.lens}\u0000${finding.category}\u0000${finding.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderPriorFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["No prior findings were banked."];
  return findings.map((finding) => {
    const files = finding.affected_files.map((entry) => entry.path).join(", ");
    return `- **${finding.id} — ${finding.title}** (${finding.lens}/${finding.severity}): ${finding.summary} [${files || "no files"}]`;
  });
}

function renderCharterProjection(bundle: ArtifactBundle): string[] {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") {
    return ["No charter register was produced for this run."];
  }
  const projection = {
    subsystems: register.subsystems.map((subsystem) => ({
      node_id: subsystem.node_id,
      members: subsystem.members,
      charters: subsystem.charters.map((charter) => ({
        charter_id: charter.charter_id,
        kind: charter.kind,
        purpose: charter.purpose,
        confidence: charter.confidence,
        provenance: charter.provenance,
        nominated_alternative: charter.nominated_alternative,
        nominated_cost: charter.nominated_cost,
      })),
    })),
    goal_graph: register.goal_graph,
    deltas: register.deltas.map((delta) => ({
      delta_id: delta.delta_id,
      node_id: delta.node_id,
      goal_node_id: delta.goal_node_id,
      pair: delta.pair,
      kind: delta.kind,
      routed_to: delta.routed_to,
      summary: delta.summary,
    })),
    triangulated: register.triangulated,
    disagreement: register.disagreement,
    validation_issues: register.validation_issues,
  };
  return ["```json", JSON.stringify(projection, null, 2), "```"];
}

function renderAdjudication(bundle: ArtifactBundle): string[] {
  const adjudication = bundle.conceptual_review_adjudication;
  if (!adjudication) {
    return ["No deep conceptual adjudication record was produced."];
  }
  return [
    `Round: \`${adjudication.round_id}\``,
    "",
    "```json",
    JSON.stringify(
      {
        contributors: adjudication.contributors.map((contributor) =>
          contributor.role === "judge"
            ? { ...contributor, result_path: undefined }
            : contributor,
        ),
        candidate_dispositions: adjudication.candidate_dispositions,
        final_finding_shares: adjudication.final_finding_shares,
        // The adversary's whole job is to challenge what the round produced, so
        // it must see the round's own outcome rates. A zero rejection rate over
        // every candidate is exactly the kind of too-good-to-be-true signal this
        // pass exists to notice, and it is invisible from the per-candidate
        // records alone.
        candidate_disposition_breakdown:
          adjudication.candidate_disposition_breakdown,
        candidate_verification_status_breakdown:
          adjudication.candidate_verification_status_breakdown,
      },
      null,
      2,
    ),
    "```",
  ];
}

/**
 * Render one systemic challenge round. `evidencePaths` are also granted in the
 * host step's read set; the prompt names them so the adversary can inspect the
 * full perspective artifacts and persisted judge adjudication rather than
 * reasoning from counts.
 */
export function renderSecondOrderAdversaryPrompt(opts: {
  round: number;
  metrics: AggregateMetricsDigest;
  submissionPath: string;
  bundle: ArtifactBundle;
  evidencePaths: readonly string[];
}): string {
  const metricLines = opts.metrics.rollups.map(
    (rollup) => `- ${rollup.label}: ${rollup.count} ${rollup.unit}`,
  );
  metricLines.push(`- Max fan-out (out-degree): ${opts.metrics.max_fan_out}`);
  const bankedFindings = priorFindings(opts.bundle);
  const evidencePaths = [...new Set(opts.evidencePaths)].sort();

  return [
    "# Design review — systemic improvement-seeking challenge (second-order adversary)",
    "",
    `You are a SEPARATE second-order adversary. This is challenge round ${opts.round}.`,
    `The audit already banked ${bankedFindings.length} distinct finding(s). Push HARDER for what those findings and their contributors missed.`,
    "",
    "## Mandate — optimization / better-way, NOT defect-finding",
    "",
    "Do NOT hunt ordinary bugs (other lenses own that). Re-interrogate the system with human-grade pressure for SUPERIOR ALTERNATIVES to things that currently work:",
    "- What is **redundant** — done more than once or more than needed?",
    "- What is **serial that could be parallel**?",
    "- What is **duplicated** across places that should share one mechanism?",
    "- What is **over-built** — complexity with no payload?",
    "- What **assumption went unquestioned**?",
    "- Is there a **categorically better approach** for a whole subsystem?",
    "",
    "## Required evidence files",
    "",
    "Read these full artifacts before concluding the round. They include the charter register, persisted conceptual judge/adjudication record, and every current-round perspective result:",
    ...evidencePaths.map((path) => `- \`${path}\``),
    "",
    "## Stated-purpose / goal / delta projection",
    "",
    "This projection comes from `charter_register.json`, not `docs_digest.json`. Treat triangulated telos as a lead, preserve disagreement, and inspect the full artifact when the projection raises a question:",
    ...renderCharterProjection(opts.bundle),
    "",
    "## Conceptual contributors, dispositions, and attribution",
    "",
    ...renderAdjudication(opts.bundle),
    "",
    "## Actual banked findings",
    "",
    ...renderPriorFindings(bankedFindings),
    "",
    "## Repository/source verification (required)",
    "",
    "Use the repository and the strongest structural tools available. For every proposed improvement, inspect exact source sites, trace relevant callers and callees in both directions, and verify the affected paths. Before any negative or exhaustive claim, check structural-index coverage/freshness and directly read every reported gap. If equivalent symbol search, bidirectional tracing, exact snippets, or coverage accounting is unavailable, state that limitation and do not present the claim as comprehensive. Aggregate counts and prior-review consensus are never proof.",
    "",
    "## Aggregate metrics (supporting evidence — necessary, NOT sufficient)",
    "",
    "These abstract, language-neutral counts are leads only:",
    ...metricLines,
    "",
    "## True lens (required)",
    "",
    "Tag each finding with its TRUE lens — for example, test parallelization is `tests` or `performance`, and operational simplification is `operability`. Do not default everything to `architecture`.",
    "",
    "## Loop-until-dry",
    "",
    "The review is done only when consecutive rounds yield NOTHING NEW. If genuine source-backed pressure finds no new improvement this round, submit an empty `findings` array. Otherwise submit only new improvements, each anchored to at least one real component.",
    "",
    "## Output",
    "",
    `Write JSON to \`${opts.submissionPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "findings": [{',
    '    "id": "<stable id>",',
    '    "title": "<the improvement>",',
    '    "category": "systemic_improvement",',
    '    "severity": "low|medium|high",',
    '    "confidence": "low|medium|high",',
    '    "lens": "<the TRUE lens: tests|performance|operability|...>",',
    '    "summary": "<what to do, why it is better, and source verification>",',
    '    "affected_files": [{ "path": "<a real repo path>" }]',
    "  }]",
    "}",
    "```",
    "",
  ].join("\n");
}
