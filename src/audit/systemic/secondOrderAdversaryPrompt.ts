// sites-pinned: tests/audit/systemic-evidence-projection.test.ts, tests/shared/prompt-renders-its-contract.test.ts, tests/shared/design-check-provenanced-input.test.ts, tests/audit/review-file-map-context.test.ts, tests/audit/review-evidence-right-sizing.test.ts
// Phase E — SECOND-ORDER ADVERSARY prompt (host_delegation).
//
// The adversary is a SEPARATE agent and receives the evidence the earlier
// design-review contributors actually produced. Aggregate metrics remain leads,
// never a substitute for charters, candidate dispositions, prior findings, and
// direct repository/source verification.

import { join } from "node:path";

import {
  FindingConfidenceSchema,
  FindingSeveritySchema,
  LENSES,
  compareCodeUnits,
} from "audit-tools/shared";

import type { ArtifactBundle } from "../io/artifacts.js";
import { resolveIntentLensSelection } from "../orchestrator/lensSelection.js";
import type { Finding } from "../types.js";
import type { AggregateMetricsDigest } from "./aggregateMetricsDigest.js";
import {
  summarizeCoveredThemes,
  type SystemicCoveredThemes,
} from "./coveredThemes.js";
import {
  buildReviewFileMap,
  reviewFileMapContext,
  unitOwnership,
  type ReviewFileMapContext,
  type ReviewFileMapScope,
  type ReviewFileMap,
} from "./reviewFileMap.js";

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

/**
 * What this round is pointed at: UNCOVERED ground. The round is told (covered
 * themes, below) to depart from every component a banked finding names, so recon
 * for those components is recon for ground it must leave. The map instead anchors
 * the files the run's deterministic leads (`design_assessment.findings`) name and
 * no banked finding does — each with its leads inline, so the round reads the
 * leads where it reads the call sites — and its index lists EVERY unit with how
 * much of it is covered and how many uncovered leads it holds. The covered files
 * stay a plain list (`renderCoveredThemes`).
 */
function adversaryReviewScope(
  bundle: ArtifactBundle,
  bankedFindings: readonly Finding[],
): ReviewFileMapScope {
  const covered = new Set(summarizeCoveredThemes(bankedFindings).files);
  const notes = new Map<string, Set<string>>();
  for (const lead of bundle.design_assessment?.findings ?? []) {
    for (const entry of lead.affected_files) {
      const path = entry.path?.trim();
      if (!path || covered.has(path)) continue;
      (notes.get(path) ?? notes.set(path, new Set()).get(path)!).add(
        `[${lead.category}/${lead.severity}] ${lead.title}`,
      );
    }
  }
  return {
    files: [...notes.keys()],
    units: (bundle.unit_manifest?.units ?? []).map((unit) => ({ unit_id: unit.unit_id, files: unit.files })),
    notes: new Map([...notes].map(([path, set]) => [path, [...set].sort(compareCodeUnits)])),
    basis:
      "the files the run's deterministic leads name that NO banked finding names — the ground this " +
      "round has not covered; each anchor carries its leads",
  };
}

function adversaryFileMap(bundle: ArtifactBundle, bankedFindings: readonly Finding[]): ReviewFileMap {
  return buildReviewFileMap(bundle, adversaryReviewScope(bundle, bankedFindings));
}

function adversaryFileMapContextFor(
  bundle: ArtifactBundle,
  bankedFindings: readonly Finding[],
  fileMap: ReviewFileMap,
): ReviewFileMapContext {
  const covered = summarizeCoveredThemes(bankedFindings).files;
  // The same owner the map's slices use (the scope's units, first claim wins),
  // so a file two units list is counted as covered once, where it is sliced.
  const owner = unitOwnership(adversaryReviewScope(bundle, bankedFindings).units ?? []);
  const leadCount = new Map(fileMap.anchors.map((anchor) => [anchor.path, anchor.notes.length]));
  return reviewFileMapContext(fileMap, {
    columns: [
      {
        header: "covered files (banked)",
        cell: (unitId) => String(covered.filter((file) => (owner.get(file) ?? null) === unitId).length),
      },
      {
        header: "uncovered leads",
        cell: (unitId) => {
          const slice = fileMap.slices.find((entry) => entry.unit_id === unitId);
          return String((slice?.files ?? []).reduce((sum, file) => sum + (leadCount.get(file) ?? 0), 0));
        },
      },
    ],
  });
}

/**
 * The call-site map a systemic challenge round receives: the index its prompt
 * carries and the read-only slice files its emission site passes to the lane
 * materializer. The same build `renderSecondOrderAdversaryPrompt` summarizes.
 */
export function adversaryFileMapContext(bundle: ArtifactBundle): ReviewFileMapContext {
  const banked = priorFindings(bundle);
  return adversaryFileMapContextFor(bundle, banked, adversaryFileMap(bundle, banked));
}

/**
 * The raw artifacts a systemic round is GRANTED as reference. Each is already
 * projected into the prompt (charter register, adjudication) or into the map
 * slices (the deterministic leads), so none is required reading.
 * `design_assessment.json` is deliberately absent: 445 KB in the 0.55.15 dogfood
 * run, nearly all metric leads, and every part a round needs is already in the
 * prompt (the banked contract/conceptual findings) or in the slices (the leads
 * on uncovered ground).
 */
export function systemicEvidencePaths(bundle: ArtifactBundle, artifactsDir: string): string[] {
  return [
    ...(bundle.charter_register ? [join(artifactsDir, "charter_register.json")] : []),
    ...(bundle.conceptual_review_adjudication
      ? [join(artifactsDir, "conceptual_review_adjudication.json")]
      : []),
    ...(bundle.conceptual_review_adjudication?.contributors
      .filter((contributor) => contributor.role === "perspective")
      .map((contributor) => contributor.result_path) ?? []),
  ];
}

function renderPriorFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["No prior findings were banked."];
  return findings.map((finding) => {
    const files = finding.affected_files.map((entry) => entry.path).join(", ");
    return `- **${finding.id} — ${finding.title}** (${finding.lens}/${finding.severity}): ${finding.summary} [${files || "no files"}]`;
  });
}

/**
 * The COVERED-THEMES digest — the variation bar's factual half.
 *
 * The banked set is already rendered in full below, and that alone did not stop
 * the loop from re-treading the same ground: round 3 of the 2026-08-21 lap
 * re-raised round 2's item under a fresh id. A flat list answers "what was
 * said"; this answers "what ground is taken", so a round can name the axis it is
 * departing on instead of inferring it from a wall of prose.
 */
function renderCoveredThemes(themes: SystemicCoveredThemes): string[] {
  if (themes.finding_count === 0) {
    return [
      "Nothing is banked yet — this round SETS the coverage rather than departing from it.",
    ];
  }
  const counts = (entries: SystemicCoveredThemes["by_lens"]): string =>
    entries.map((entry) => `${entry.value} (${entry.count})`).join(", ") || "none";
  return [
    `${themes.finding_count} improvement(s) are banked, covering:`,
    "",
    `- **Lenses already used:** ${counts(themes.by_lens)}`,
    `- **Categories already used:** ${counts(themes.by_category)}`,
    `- **Components already implicated:** ${themes.files.join(", ") || "none"}`,
    "",
    "That is COVERED GROUND. Re-raising any of it — in the same words or in different ones — " +
      "is not a new finding and will not keep this loop open. This round owes a DEPARTURE: a " +
      "different axis, a different component, or a categorically better approach to something " +
      "the list above does not already name.",
  ];
}

function renderCharterProjection(bundle: ArtifactBundle): string[] {
  const register = bundle.charter_register;
  if (!register || register.status === "omitted") {
    return ["No charter register was produced for this run."];
  }
  // The three lane goal DAGs unmerged, the correspondences between them, and the
  // verified differences — the accounts stand side by side (never a unified telos).
  const projection = {
    lanes: register.lanes.map((lane) => ({
      kind: lane.kind,
      nodes: lane.nodes.map((n) => ({
        node_id: n.node_id,
        purpose: n.purpose,
        premise_height: n.premise_height,
        files: n.files,
        confidence: n.confidence,
      })),
      edges: lane.edges.map((e) => ({ from: e.from, to: e.to })),
    })),
    correspondences: register.correspondences.map((c) => ({
      correspondence_id: c.correspondence_id,
      members: c.members,
      basis: c.basis,
    })),
    differences: register.differences.map((d) => ({
      difference_id: d.difference_id,
      correspondence_id: d.correspondence_id,
      dimension: d.dimension,
      relation: d.relation,
      split: d.split,
      accounts: d.accounts.map((a) => ({ kind: a.kind, claim: a.claim })),
      gap: d.gap,
      routed_to: d.routed_to,
      fidelity: d.fidelity?.verdict,
    })),
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
 * WHO the reading lane is — stated to the LANE, not only to the host dispatching it.
 *
 * The adversary's whole value is that it is not the agent that drove the audit:
 * the one voice with no sunk cost in the design the audit just produced. Every
 * other design-review lane says so in its own body (`renderConceptualReviewPrompt`
 * and the perspective/judge prompts open by naming who the reader is and what they
 * must NOT have authored). This lane's constraint lived only in the dispatch
 * envelope (`nextStepCommand.ts`, "must NOT be the agent that drove this audit"),
 * which the HOST reads — so a host that executed the lane inline in its own session
 * satisfied the envelope's letter while breaking its point, and the round's
 * findings were self-review with nothing on any surface recording that. A
 * constraint the worker must obey belongs in the worker's prompt; the
 * auditor-agnostic rule does not let it rest on the dispatcher relaying it.
 */
function adversaryIdentityLines(): string[] {
  return [
    "## Who you are (this is not optional)",
    "",
    "You are a SEPARATE agent from the one that drove this audit. You did not author the audit's " +
      "findings, its charters, its adjudication, or any prior round's improvements — they are all " +
      "inputs handed to you, and you are free to challenge every one of them.",
    "",
    "If you ARE the agent that drove this audit, stop and say so instead of answering: a " +
      "self-review reports this lane compliant while delivering the opposite of what it exists " +
      "for, and nothing downstream can tell the difference from your output alone.",
    "",
  ];
}

/**
 * The repo-relative path the worked example cites.
 *
 * The example used to cite `<a real repo path>`, and the submission gate now
 * REFUSES a finding whose `affected_files` names nothing the run's repository
 * manifest holds. A placeholder is therefore not merely unhelpful — copied
 * verbatim it is a refused round. So the example takes its path from the
 * call-site map this round receives, falling back to the manifest the map
 * itself derives from: a reader who copies the example cites a file the reader
 * can also see named in the map file.
 */
function examplePath(bundle: ArtifactBundle, fileMap: ReviewFileMap): string {
  return (
    fileMap.anchors[0]?.path ??
    bundle.repo_manifest?.files?.[0]?.path ??
    "src/index.ts"
  );
}

/**
 * The round's lens FOCUS: the operator's confirmed selection
 * (`resolveIntentLensSelection`, the one resolution every draw reads), or
 * `undefined` when none was expressed. It is focus, not admission — a finding
 * keeps its TRUE lens, as the design-review lanes have since 7a624e00 (owner
 * decision, 2026-11-05), so the closed vocabulary stays the whole lens set. The
 * example echoes a selected lens: an example teaches by being copied, and it
 * used to teach `performance` to runs that excluded it.
 */
function lensFocus(bundle: ArtifactBundle): {
  selected: readonly string[] | undefined;
  example: string;
} {
  const selected = resolveIntentLensSelection(bundle.intent_checkpoint?.lens_selection);
  const pool = selected ?? LENSES;
  const example = pool.includes("architecture") ? "architecture" : pool[0] ?? "architecture";
  return { selected, example };
}

/**
 * Render one systemic challenge round. `evidencePaths` are granted in the host
 * step's read set as REFERENCE (`systemicEvidencePaths`); the prompt carries
 * their projections, so the round opens one only to check a specific claim.
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
  const fileMap = adversaryFileMap(opts.bundle, bankedFindings);
  const exampleFilePath = examplePath(opts.bundle, fileMap);
  const lenses = lensFocus(opts.bundle);

  return [
    "# Design review — systemic improvement-seeking challenge (second-order adversary)",
    "",
    `You are a SEPARATE second-order adversary. This is challenge round ${opts.round}.`,
    `The audit already banked ${bankedFindings.length} distinct finding(s). Find what those findings and their contributors missed.`,
    "",
    ...adversaryIdentityLines(),
    "## Mandate — optimization / better-way, NOT defect-finding",
    "",
    "Do NOT hunt ordinary bugs (other lenses own that). Press for SUPERIOR ALTERNATIVES to things that currently work:",
    "- What is **redundant** — done more than once or more than needed?",
    "- What is **serial that could be parallel**?",
    "- What is **duplicated** across places that should share one mechanism?",
    "- What is **over-built** — complexity with no payload?",
    "- What **assumption went unquestioned**?",
    "- Is there a **categorically better approach** for a whole subsystem?",
    "",
    "## What this prompt already digests, and the reference artifacts behind it",
    "",
    "This prompt carries the evidence the round needs, pre-digested: the charter register's " +
      "stated-purpose/goal/delta projection, the conceptual adjudication's contributors and " +
      "dispositions, every banked finding, and the covered themes — all below — and the " +
      "deterministic leads on uncovered ground, inside the call-site map slices. Do NOT read the raw " +
      "artifacts whole. They are granted as REFERENCE: open one only to check a specific claim a " +
      "projection raises, and read only the part that claim needs." +
      (evidencePaths.length > 0 ? "" : " No reference artifact exists for this run."),
    ...evidencePaths.map((path) => `- \`${path}\``),
    "",
    "## Prior verified recon — uncovered ground, read the slices you need BEFORE re-deriving anything",
    "",
    // The index only: the slices reach the lane as read-only context files its
    // emission site binds (`adversaryFileMapContext`).
    ...adversaryFileMapContextFor(opts.bundle, bankedFindings, fileMap).summaryLines,
    "## Stated-purpose / goal / delta projection",
    "",
    "Treat a triangulated purpose as a lead. Preserve disagreement, and inspect the full artifact when the projection raises a question:",
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
    "## Covered themes — what this round must depart from",
    "",
    ...renderCoveredThemes(summarizeCoveredThemes(bankedFindings)),
    "",
    "## Variation bar (required)",
    "",
    "For every finding you submit, you must be able to state — in its `summary` — which axis it " +
      "departs on relative to the covered themes above: a component no banked finding names, a " +
      "mechanism class none of them addresses, or a categorically different approach to something " +
      "they only patch. A finding that cannot name its axis is a restatement, and this loop closes " +
      "on restatements rather than counting them as progress.",
    "",
    "## Repository/source verification (required)",
    "",
    "Use the repository and the strongest structural tools available. The call-site map slices are " +
      "your starting recon for uncovered ground — verify the sites your improvements build on, " +
      "rather than rebuilding the map. For every proposed improvement, inspect exact source sites, trace " +
      "relevant callers and callees in both directions, and verify the affected paths. Before any " +
      "negative or exhaustive claim, check structural-index coverage/freshness and directly read " +
      "every reported gap. If equivalent symbol search, bidirectional tracing, exact snippets, or " +
      "coverage accounting is unavailable, state that limitation and do not present the claim as " +
      "comprehensive. Aggregate counts and prior-review consensus are never proof.",
    "",
    "## Aggregate metrics (supporting evidence — necessary, NOT sufficient)",
    "",
    "Language-neutral counts are leads only, never proof:",
    ...metricLines,
    "",
    "## Lens and evidence (required)",
    "",
    "- Tag each finding with the lens it genuinely belongs to, from the closed `lens` list below. " +
      "Do not default everything to `architecture`.",
    ...(lenses.selected !== undefined
      ? [
          `- The operator selected these lenses for this audit: ${lenses.selected.join(", ")}. ` +
            "Spend this round there. A finding that genuinely belongs to another lens is still " +
            "filed under the lens it belongs to — never relabelled into a selected one.",
        ]
      : []),
    "- Every finding needs at least one `evidence` entry: write down what your source verification " +
      "actually found. A finding submitted without one is REFUSED.",
    "- Cite SYMBOLS, not line numbers — a function, type, or exported name, with the file that " +
      "holds it. A line number is wrong after the next edit; a symbol name survives. Aggregate " +
      "counts are not evidence on their own; name the thing you read.",
    "",
    "## Grounding — every improvement names a real file (required)",
    "",
    "Each finding's `affected_files` must name at least one file THIS repository holds, written " +
      "repo-relative and spelled as the call-site map slices and the manifest spell it. A submission carrying an " +
      "improvement that names no such file is REFUSED as a whole, and the refusal names the " +
      "finding: correct the path and resubmit. An improvement pointing at nothing cannot be " +
      "verified, dispatched, or remediated.",
    "",
    "## Closed field vocabularies",
    "",
    `- \`severity\`: ${FindingSeveritySchema.options.join(" | ")}`,
    `- \`confidence\`: ${FindingConfidenceSchema.options.join(" | ")}`,
    `- \`lens\`: ${LENSES.join(" | ")}`,
    "",
    "Each list is closed. A value outside it refuses the submission — write one member, never the " +
      "list itself.",
    "",
    "## Loop-until-dry",
    "",
    "The review is done only when consecutive rounds yield NOTHING NEW. The tool also bounds this " +
      "loop at a fixed number of rounds, so it ends whether or not it is dry.",
    "",
    "- **If this round found nothing new** — submit `\"findings\": []` and stop normally. Quiet " +
      "rounds are how this loop ends. Do NOT manufacture a finding to look productive, and do NOT " +
      "withhold a real one to end the loop sooner: either one turns the dry signal into noise, and " +
      "that signal is the loop's only evidence that the work is done.",
    "- **If you are stopping before the loop is dry** (budget spent, no further yield available) — " +
      "say so with a top-level `stop` object (shape below) and state the reason. That ending is " +
      "recorded as a HOST-FORCED stop, distinct from convergence. Never submit an empty `findings` " +
      "array to mean \"I am stopping\": an empty array asserts the round found nothing new.",
    "",
    "## Finding ids",
    "",
    "Supply a short, stable `id` of your own per finding. The tool namespaces it per round, so the " +
      "same id in two rounds can never stand for two different improvements.",
    "",
    "## Output",
    "",
    `Write JSON to \`${opts.submissionPath}\` with this shape:`,
    "",
    "```json",
    "{",
    '  "findings": [{',
    '    "id": "<your short id>",',
    '    "title": "<the improvement>",',
    '    "category": "systemic_improvement",',
    '    "severity": "medium",',
    '    "confidence": "high",',
    `    "lens": ${JSON.stringify(lenses.example)},`,
    '    "summary": "<what to do, why it is better, which axis it departs on, and source verification>",',
    '    "evidence": ["<symbol you read, the file holding it, and what you found there>"],',
    `    "affected_files": [{ "path": ${JSON.stringify(exampleFilePath)} }]`,
    "  }]",
    "}",
    "```",
    "",
    "To stop the loop early, add the `stop` key to that same document. Keep in `findings` whatever " +
      "this round did deliver — a stop never discards delivered work:",
    "",
    "```json",
    "{",
    '  "findings": [],',
    '  "stop": { "forced": true, "reason": "<why the loop is being stopped before it is dry>" }',
    "}",
    "```",
    "",
  ].join("\n");
}
