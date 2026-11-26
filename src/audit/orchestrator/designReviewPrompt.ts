// sites-pinned: tests/audit/intent-checkpoint-extended.test.ts, tests/audit/conceptual-charter-context.test.ts, tests/audit/review-submission.test.ts, tests/shared/design-check-provenanced-input.test.ts, tests/audit/review-file-map-context.test.ts, tests/audit/review-evidence-right-sizing.test.ts
import type { ArtifactBundle } from "../io/artifacts.js";
import type { Finding } from "../types.js";
import { compareCodeUnits, confidenceRank, severityRank, uniqueSorted } from "audit-tools/shared";
import type { NodeMetrics } from "audit-tools/shared";
import { resolveIntentLensSelection } from "./lensSelection.js";
import { projectConceptualCharterContext } from "./designReviewTask.js";
import { designReviewInputRevision, sortedDesignLeadLocations } from "./designReviewProjection.js";
import { degradedAnalyzerEntries } from "../types/analyzerCapability.js";
import {
  buildReviewFileMap,
  reviewFileMapContext,
  type ReviewFileMapContext,
  type ReviewFileMapScope,
} from "../systemic/reviewFileMap.js";
import {
  deriveUnitScopeDisposition,
  designReviewPrimaryFiles,
  type UnitScopeDisposition,
} from "./intentScopeDisposition.js";
import { ReviewSubmissionEnvelopeSchema } from "audit-tools/shared";
import { OUTSIDE_IN_PERSPECTIVE_NAME, type ConceptualPerspective } from "../../shared/types/conceptualPerspective.js";
import { ConceptualJudgeSubmissionSchema } from "../types/conceptualAdjudication.js";
import { DesignLeadCategorySchema } from "../types/designAssessment.js";
import { BUILT_IN_REVIEW_LENSES, BuiltInReviewLensSchema } from "../../shared/types/reviewQuestion.js";
import { REVIEW_LENS_PLAYBOOKS } from "./reviewLensPlaybooks.js";

/**
 * Where the judge's object sits, DERIVED from the two schemas that parse it.
 * The judge lane is a bound review lane: its file is a review-submission
 * envelope whose domain object travels in one key, and the judge schema is
 * applied to that key's value. Saying "top-level" named the envelope's top
 * level to a reader holding the envelope, so a judge could set `round_id`
 * beside `result` — a placement the validator refuses. Typing the key against
 * the envelope's shape means a renamed envelope key breaks the build here.
 */
const ENVELOPE_SHAPE = ReviewSubmissionEnvelopeSchema.shape;
const ENVELOPE_RESULT_KEY: keyof typeof ENVELOPE_SHAPE = "result";
const ENVELOPE_CONTRACT_VERSION = ENVELOPE_SHAPE.contract_version.value;
const JUDGE_RESULT_KEYS = Object.keys(ConceptualJudgeSubmissionSchema.shape);
const JUDGE_RESULT_PLACEMENTS = JUDGE_RESULT_KEYS
  .map((key) => `\`${ENVELOPE_RESULT_KEY}.${key}\``)
  .join(", ");

/**
 * The category a CONFIRMED structural lead keeps, rendered beside every pass's
 * own category list from `DesignLeadCategorySchema` — the same set the lead
 * producers are typed against. The lead list tells a reader to retain a
 * confirmed lead's category so `mergeFindings` can match the confirmation; a
 * permitted list without these categories made that instruction unobeyable.
 */
const LEAD_CATEGORY_RULE =
  "A finding that confirms a structural lead in your review evidence keeps that lead's category instead, one of: " +
  `${DesignLeadCategorySchema.options.join(", ")}.`;

/** Render the `[in scope]` / `[excluded: reason]` tag for a unit disposition. */
function scopeTag(disposition: UnitScopeDisposition): string {
  return disposition.kind === "excluded"
    ? `[excluded: ${disposition.reason}]`
    : "[in scope]";
}

function summarizeUnits(bundle: ArtifactBundle, limit = 40): string {
  const units = bundle.unit_manifest?.units ?? [];
  if (units.length === 0) return "No units identified.";

  const checkpoint = bundle.intent_checkpoint;
  return formatTopNList(
    units,
    limit,
    (total) => `${total} units:`,
    (unit) => {
      const lenses = unit.required_lenses.join(", ") || "none";
      const tag = scopeTag(deriveUnitScopeDisposition(unit.files, checkpoint));
      return `- ${unit.unit_id} ${tag} (${unit.files.length} files, lenses: ${lenses})`;
    },
  );
}

function summarizeGraph(bundle: ArtifactBundle): string {
  const graphs = bundle.graph_bundle?.graphs;
  if (!graphs) return "No dependency graph available.";

  const counts: string[] = [];
  for (const [kind, edges] of Object.entries(graphs)) {
    if (Array.isArray(edges) && edges.length > 0) {
      counts.push(`${kind}: ${edges.length} edges`);
    }
  }

  if (counts.length === 0) return "Dependency graph is empty.";
  return `Dependency graph: ${counts.join(", ")}.`;
}

/** Formats a top-N list with header, lines, and "more" indicator. */
function formatTopNList<T>(
  items: T[],
  max: number,
  headerFn: (total: number, shown: number) => string,
  lineFn: (item: T) => string,
): string {
  if (items.length === 0) return "";

  const shown = items.slice(0, max);
  const lines = shown.map(lineFn);

  return [
    headerFn(items.length, shown.length),
    ...lines,
    ...(items.length > max ? [`  ... and ${items.length - max} more`] : []),
  ].join("\n");
}

function summarizeFlows(bundle: ArtifactBundle, max = 15): string {
  const flows = bundle.critical_flows?.flows ?? [];
  if (flows.length === 0) return "No critical flows identified.";

  return formatTopNList(
    flows,
    max,
    (total) => `${total} critical flows:`,
    (flow) => `- ${flow.name}: ${flow.paths.length} files, concerns: ${flow.concerns.join(", ") || "none"}`,
  );
}

function summarizeRisk(bundle: ArtifactBundle): string {
  const items = bundle.risk_register?.items ?? [];
  if (items.length === 0) return "No risk items.";

  const sorted = [...items].sort((a, b) => b.risk_score - a.risk_score);
  const top = sorted.slice(0, 10);
  const lines = top.map(
    (item) =>
      `- ${item.unit_id}: score ${item.risk_score}, signals: ${item.signals.join(", ") || "none"}`,
  );

  return [
    `${items.length} risk items (top ${top.length} by score):`,
    ...lines,
  ].join("\n");
}

/**
 * The units the "Starting points" section names: the top `maxUnits` by risk
 * score, or — with no risk data — the first `maxUnits` units. Single-sourced so
 * the call-site map anchors exactly the files the reading list names.
 */
interface StartingPoints {
  /** Total risk items (ranked) — 0 when the unranked fallback was used. */
  risk_item_count: number;
  all_units_excluded: boolean;
  entries: Array<{ unit_id: string; risk_score?: number; files: readonly string[] }>;
}

function selectStartingPoints(bundle: ArtifactBundle, maxUnits: number): StartingPoints {
  const allUnits = bundle.unit_manifest?.units ?? [];
  const excluded = new Set(bundle.repo_manifest?.files.filter(file => file.excluded).map(file => file.path));
  const units = allUnits.map(unit => ({ ...unit, files: designReviewPrimaryFiles(unit.files, bundle.intent_checkpoint, excluded) }))
    .filter((unit, index) => unit.files.length > 0 || allUnits[index]!.files.length === 0);
  const all_units_excluded = allUnits.length > 0 && units.length === 0;
  const unitFiles = new Map<string, string[]>();
  for (const unit of units) {
    unitFiles.set(unit.unit_id, unit.files);
  }

  const items = (bundle.risk_register?.items ?? []).filter(item => allUnits.length === 0 || unitFiles.has(item.unit_id));

  // Sort eligible risk items by score descending, then take the top-N
  const top = items.sort((a, b) => b.risk_score - a.risk_score).slice(0, maxUnits);
  if (top.length === 0) {
    return {
      risk_item_count: 0,
      all_units_excluded,
      entries: units
        .slice(0, maxUnits)
        .map((unit) => ({ unit_id: unit.unit_id, files: unit.files })),
    };
  }
  return {
    risk_item_count: items.length,
    all_units_excluded,
    entries: top.map((item) => ({
      unit_id: item.unit_id,
      risk_score: item.risk_score,
      files: unitFiles.get(item.unit_id) ?? [],
    })),
  };
}

/**
 * What a design-review round is pointed at: the files of its starting-point
 * units. The round may roam past them, but these are the files its prompt names
 * as starting points, so they are the ones considered for call-site map anchors.
 */
function startingPointReviewScope(points: StartingPoints): ReviewFileMapScope {
  return {
    files: points.entries.flatMap((entry) => entry.files),
    // Sliced by the starting points themselves, in the order the prompt lists them.
    units: points.entries.map((entry) => ({ unit_id: entry.unit_id, files: entry.files })),
    basis:
      `the files of the ${points.entries.length} starting-point unit(s) listed under ` +
      `"Starting points" in the review prompt`,
  };
}

/** The starting-point count a design-review prompt orients on, unless the caller sets one. */
function resolveMaxUnits(bundle: ArtifactBundle, options: DesignReviewOptions): number {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  return options.max_units ?? Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
}

function fileMapContextFor(bundle: ArtifactBundle, points: StartingPoints): ReviewFileMapContext {
  return reviewFileMapContext(buildReviewFileMap(bundle, startingPointReviewScope(points)));
}

function buildPrioritizedReadingList(points: StartingPoints): string {
  if (points.all_units_excluded) return "No in-scope starting units; excluded units are context only.";
  if (points.entries.length === 0) {
    return "No risk or unit data available; read the repository root files to orient yourself.";
  }

  if (points.risk_item_count === 0) {
    const lines = points.entries.map((u) => `- **${u.unit_id}** — ${u.files.length} file(s)`);
    return [
      `Top ${points.entries.length} unit(s) (no risk scores available):`,
      ...lines,
    ].join("\n");
  }

  const lines = points.entries.map((entry) => {
    const fileList = entry.files.length > 0 ? `${entry.files.length} file(s)` : "(files unknown)";
    return `- **${entry.unit_id}** (risk score: ${entry.risk_score}) — ${fileList}`;
  });

  return [
    `Top ${points.entries.length} highest-risk unit(s) by risk score (out of ${points.risk_item_count} total):`,
    ...lines,
  ].join("\n");
}

function summarizeSurfaces(bundle: ArtifactBundle, max = 20): string {
  const surfaces = bundle.surface_manifest?.surfaces ?? [];
  if (surfaces.length === 0) return "No externally reachable surfaces identified.";

  return formatTopNList(
    surfaces,
    max,
    (total) => `${total} surfaces:`,
    (surface) => `- ${surface.id} (${surface.kind}): ${surface.entrypoint}${surface.methods?.length ? ` [${surface.methods.join(", ")}]` : ""}`,
  );
}

function summarizeFiles(bundle: ArtifactBundle): string {
  const files = bundle.repo_manifest?.files ?? [];
  if (files.length === 0) return "No files in manifest.";

  const byLanguage = new Map<string, number>();
  for (const file of files) {
    const lang = file.language || "unknown";
    byLanguage.set(lang, (byLanguage.get(lang) ?? 0) + 1);
  }

  const langSummary = [...byLanguage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}: ${count}`)
    .join(", ");

  return `${files.length} files (${langSummary}).`;
}

/**
 * The per-node metric behind each metric-lead category: its rows all share one
 * severity and confidence, so the metric value is what separates them.
 */
const METRIC_KIND_BY_CATEGORY: Readonly<Record<string, "complexity" | "duplication">> = {
  complexity_hotspot: "complexity",
  code_duplication: "duplication",
};

/** The metric value behind a metric lead (its first affected file's), else undefined. */
function leadMagnitude(finding: Finding, nodeMetrics: NodeMetrics | undefined): number | undefined {
  const kind = METRIC_KIND_BY_CATEGORY[finding.category];
  const path = finding.affected_files[0]?.path;
  if (!kind || path === undefined) return undefined;
  return nodeMetrics?.[path]?.[kind]?.value;
}

/**
 * Order deterministic findings so a bounded window represents every KIND
 * (category) instead of whichever detector emits the most rows. Within a kind,
 * rows rank by severity, then confidence, then metric value descending (a
 * complexity-80 routine before a complexity-11 one), then first affected path.
 * Kinds are then interleaved round-robin — each kind's best row, then each
 * kind's second, … — with kinds ranked by their best row's severity and
 * confidence, then by category name. Every key is content-derived, so detector
 * emission order never decides what is shown.
 */
function representativeOrder(findings: Finding[], nodeMetrics?: NodeMetrics): Finding[] {
  const kindRank = (a: Finding, b: Finding): number =>
    severityRank(b.severity) - severityRank(a.severity) ||
    confidenceRank(b.confidence) - confidenceRank(a.confidence);
  const rank = (a: Finding, b: Finding): number =>
    kindRank(a, b) ||
    (leadMagnitude(b, nodeMetrics) ?? -Infinity) - (leadMagnitude(a, nodeMetrics) ?? -Infinity) ||
    compareCodeUnits(a.affected_files[0]?.path ?? "", b.affected_files[0]?.path ?? "");
  const byKind = new Map<string, Finding[]>();
  for (const finding of findings) {
    const rows = byKind.get(finding.category) ?? [];
    rows.push(finding);
    byKind.set(finding.category, rows);
  }
  const kinds = [...byKind.entries()]
    .map(([category, rows]) => ({ category, rows: [...rows].sort(rank) }))
    .sort((a, b) => kindRank(a.rows[0]!, b.rows[0]!) || compareCodeUnits(a.category, b.category));
  const ordered: Finding[] = [];
  for (let depth = 0; ordered.length < findings.length; depth += 1) {
    for (const kind of kinds) {
      const row = kind.rows[depth];
      if (row) ordered.push(row);
    }
  }
  return ordered;
}

/** Per-kind counts of the rows a bounded window left out, largest first. */
function omittedByKind(omitted: Finding[]): string[] {
  if (omitted.length === 0) return [];
  const counts = new Map<string, number>();
  for (const finding of omitted) counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
    .map(([category, count]) => `${category} ${count}`);
  return [`  Not shown by kind: ${parts.join(", ")}`];
}

function formatDeterministicFindings(findings: Finding[], nodeMetrics: NodeMetrics | undefined, lenses: readonly string[] | undefined, max = 20): string {
  if (findings.length === 0)
    return "No structural issues detected by deterministic analysis.";

  // Split by lineage: a finding a deterministic producer stamped is a LEAD and
  // says so; anything else in this list arrived without a lineage record. The
  // boundary is stated rather than left to the reader, because the failure it
  // guards is a heuristic being read as an approved finding — a reader who does
  // not know which rows are leads will treat them all as verdicts.
  const unlineaged = findings.filter((finding) => finding.lead_lineage === undefined);
  const ordered = representativeOrder(findings, nodeMetrics);
  const selected = new Set(lenses ?? BUILT_IN_REVIEW_LENSES);

  return [
    formatTopNList(
      ordered,
      max,
      (total) =>
        `${total} structural findings from deterministic analysis — **leads, not verdicts**. ` +
        "Each is a deterministic heuristic over a generation of the repo; a heuristic can be " +
        "right about the structure and wrong about the project. Confirm one against real code " +
        "before treating it as a finding. If confirmed under a selected lens, retain the lead's true lens, category, title, and affected file paths " +
        "from its identity below so the tool can match the confirmation; independently determine severity, confidence, summary, and evidence " +
        "from real code. Leads whose owning lens was not selected are context only: do not promote, relabel, or count them as coverage. Do not copy an unverified verdict or supply lead_lineage: the tool attaches provenance after matching.",
      (finding) =>
        `- [${finding.severity}] ${finding.title}: ${finding.summary}` +
        (finding.lead_lineage
          ? ` _(lead: ${finding.lead_lineage.producer})_` +
            `\n  ${selected.has(finding.lens) ? "Confirmation identity" : "Context-only lead identity"}: ${JSON.stringify({ lens: finding.lens, category: finding.category, title: finding.title, affected_files: sortedDesignLeadLocations(finding.affected_files) })}`
          : ""),
    ),
    ...omittedByKind(ordered.slice(max)),
    // Any finding here WITHOUT a lineage record is called out rather than
    // silently absorbed into the list above: an unstamped row means a producer
    // emitted it without declaring itself, which is the gap this section exists
    // to make visible.
    ...(unlineaged.length > 0
      ? [
          "",
          `⚠ ${unlineaged.length} of these carry NO producer lineage record. Treat them as ` +
            "unverified deterministic output and confirm each against code before reporting it.",
        ]
      : []),
  ].join("\n");
}

export interface DesignReviewOptions {
  max_units?: number;
  conceptual_depth?: "shallow" | "deep";
  /**
   * The operator's RESOLVED lens selection, as
   * `resolveIntentLensSelection` produced it. Absent when the operator
   * expressed no limit at all.
   *
   * It reached no semantic channel: this options object — the one every
   * design-review, contract, conceptual, perspective and judge prompt is
   * rendered with — had no lens field, and the only lens literal a lane ever saw
   * was the output example's hard-coded `"architecture"`. The delivered
   * distribution was exactly the set of literals in the deterministic producers.
   *
   * A prompt cannot FORCE a model to produce a finding, so this is not the
   * guarantee (the report's `lens_coverage` is). It is what makes `clean` — the
   * "asked, and there was nothing there" answer — reachable at all.
   */
  lenses?: readonly string[];
}

/**
 * State the operator's lens scope for a lens-open lane, and give the output
 * example a lens to echo instead of a hard-coded one.
 */
function renderLensScope(options: DesignReviewOptions): string[] {
  const lenses = options.lenses ?? BUILT_IN_REVIEW_LENSES;
  return [
    "## Lenses in scope",
    "",
    ...(lenses.length === 0
      ? ["The operator selected no question lens. Keep any separate design discussion distinct from findings and coverage."]
      : [
          `Question lenses for this review: ${lenses.join(", ")}.`,
          ...lenses.map((lens) => {
            const builtIn = BuiltInReviewLensSchema.safeParse(lens);
            return `- ${lens}: ${builtIn.success ? REVIEW_LENS_PLAYBOOKS[builtIn.data] : "Answer the independently declared custom question; do not infer its scope from its ID."}`;
          }),
          "Assign each finding its owning selected lens. Preserve a discovery for a different lens as a linked lead or unresolved question; do not claim coverage of an unassigned lens.",
        ]),
    "",
  ];
}

/**
 * The lens literal the findings example echoes: the first selected, else a real
 * lens from the eleven-lens vocabulary.
 *
 * It used to fall back to the DESCRIPTION `"the lens this finding belongs to"`.
 * `lens` is a free string in the finding contract, so a host that copied the
 * example was accepted, and `lens_breakdown` — a `countBy` over what was
 * produced — then reported a lens named after the placeholder. An example
 * teaches by being copied, so every literal in it must be a value the tool would
 * be content to receive (owner decision, 2026-09-17).
 */
function exampleLens(options: DesignReviewOptions): string {
  return options.lenses?.[0] ?? "architecture";
}

/**
 * A real repository path for the example's `affected_files`, taken from the
 * manifest this prompt already prints in its file inventory.
 *
 * The example used to cite `relevant/file.ts`, which is not in any repository.
 * `groundDesignFindings` resolves `affected_files` against the manifest, so a
 * copied example grounds as
 * `{"status":"ungrounded","reason":"cited component(s) not found …"}` — the
 * prompt taught the one citation its own grounding pass refuses.
 */
function examplePath(bundle: ArtifactBundle): string {
  return bundle.repo_manifest?.files?.[0]?.path ?? "src/index.ts";
}

export { CONCEPTUAL_PERSPECTIVES, DEFAULT_CONCEPTUAL_PERSPECTIVES, selectPerspectives } from "../../shared/types/conceptualPerspective.js";

/**
 * Shared "how to think" block for the conceptual-review prompts. This is the
 * lens meant to catch deep architectural mistakes, so it asks GENERAL,
 * first-principles questions and tells the reviewer to orient then roam the real
 * code — never a project-specific checklist (it must work on any repository).
 */
function conceptualCritiqueInstructions(): string[] {
  return [
    "## Orient, then roam",
    "",
    "The structural context is a map to orient you — it is NOT your reading list, and it is not where the deep problems will be obvious. Before forming conclusions:",
    "",
    "- **Read the project's own documentation first** — its README, anything under `docs/`, design notes, and any `CLAUDE.md`/agent-instruction files — to learn what this project is *trying* to be and why. Understand the intent before you judge the execution.",
    "- **Then roam the actual code freely.** Read whole files, follow imports and call paths wherever they lead, and build your own mental model the way a new senior engineer would. Do NOT confine yourself to the highest-risk units — emergent, whole-system problems live in the connections between ordinary-looking parts, which no per-unit risk score surfaces.",
    "",
    // Two DIFFERENT rules, deliberately named apart. The grant above is about
    // what you may READ; the rule below is about what you may REPORT. Conflating
    // them is what let the doc and this prompt disagree: the doc described a
    // graph-constrained reading grant, the prompt granted free roaming, and
    // neither stated the finding-target scope the annotations already imply.
    "**Roaming is a reading grant, not a reporting grant.** Read anything you need in order to understand the system. But produce findings only about units marked `[in scope]` in Unit structure — a unit marked `[excluded: <reason>]` may inform your reasoning and may be cited as evidence, and must never itself be the target of a finding.",
    "",
    "## How to think — first principles, not a checklist",
    "",
    "Interrogate the design from the ground up. These are starting questions, not a form to fill — follow the ones that prove fruitful for THIS codebase:",
    "",
    "- **Is the fundamental approach the right one?** If you were starting clean today, knowing what this project must do, would you build it this way? What would a clean-sheet redesign do differently, and why?",
    "- **What core assumption does this design rest on — and is it sound?** Name the load-bearing assumption (about the domain, the inputs, the scale, the consumers, the failure model). What breaks if it is wrong, and is anything relying on it without checking?",
    "- **Where is the deepest structural risk?** Not the worst single line — the place where the *shape* of the system will hurt most as it grows, changes hands, or meets reality. What is fragile by construction?",
    "- **Does the structure match the problem?** Where do the abstractions, boundaries, and responsibilities fit the problem, and where do they cut across it — forcing one change to ripple through many places, or one place to know too much?",
    "- **What is the design optimizing for, and is that the right thing?** Every design trades simplicity, flexibility, performance, and clarity against each other. Is this project's implicit trade-off the one it should be making?",
    "- **What is missing that the design will eventually need** — a capability, a seam, a constraint, an integration — that is cheap to add now and expensive later?",
    "",
    "Reason about the system as a whole. Prefer naming the single change that would most improve the design over a long list of small ones. If the approach is genuinely sound, say so — with the evidence that convinced you.",
    "",
  ];
}

/**
 * The canonical design-review submission is a JSON OBJECT with a top-level
 * `findings` array — `{ "findings": [ ... ] }` — NOT a bare top-level array. A
 * bare array cannot be emitted by a `json_object`-constrained worker (a NIM
 * single-shot lane physically cannot return a top-level array), so such a lane
 * had to be special-cased or skipped for design-review packets; the object
 * envelope is universally emittable and matches every other host-gate
 * submission. The design-review ingest
 * (`unwrapSubmissionArray`) tolerantly unwraps the single `findings` array, so
 * the shape round-trips. `categories` is the per-pass category vocabulary — the
 * one line that differs between the TWO passes the tool runs: the contract pass
 * (`renderContractReviewPrompt`) and the conceptual pass
 * (`CONCEPTUAL_FINDING_CATEGORIES`).
 *
 * EVERY LITERAL IN THE EXAMPLE IS A VALUE THE TOOL ACCEPTS (owner decision,
 * 2026-09-17). This example used to put each closed enum's ALTERNATION in the
 * field value — `"severity": "one of: critical, high, medium, low, info"` — so a
 * host that copied it wrote a string no code recognises. The judge door refused
 * it; the contract and shallow-conceptual doors did not, and the finding was
 * stamped `grounded` with a severity `SEVERITY_RANK` cannot rank. The vocabulary
 * now sits BESIDE the example, where it reads as a list of permitted values
 * rather than as one.
 */
function findingsEnvelopeExample(
  categories: readonly string[],
  lensExample: string,
  examplePathValue: string,
): string[] {
  return [
    "```json",
    "{",
    '  "findings": [',
    "    {",
    '      "id": "DR-001",',
    '      "title": "Retry limit is enforced in two places that can disagree",',
    `      "category": "${categories[0]}",`,
    '      "severity": "high",',
    '      "confidence": "medium",',
    `      "lens": "${lensExample}",`,
    '      "summary": "detailed explanation of the observation and the recommended change",',
    `      "affected_files": [{"path": ${JSON.stringify(examplePathValue)}}],`,
    '      "systemic": true',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    `Write the literal value, never the list of permitted ones. \`category\` is one of: ${categories.join(", ")}. ${LEAD_CATEGORY_RULE} ` +
      "`severity` is one of: critical, high, medium, low, info. `confidence` is one of: high, medium, low. " +
      "`affected_files` cites a real path from the file inventory. Every finding is parsed against " +
      "this contract at ingestion, and a submission carrying one that fails is refused whole — not " +
      "partly accepted — so a placeholder value costs you the round.",
    "",
    "Do NOT supply `verification_status`, `evidence_lane` or `lead_lineage`. The tool derives all three " +
      "at ingestion, and a submission that supplies any of them is refused by name.",
  ];
}

/**
 * The contract pass's category vocabulary. Named data, beside the conceptual
 * one, because the example and the prose that states the permitted values are
 * now built from the SAME array — a second hand-written copy is how the two
 * drifted apart in the first place.
 */
export const CONTRACT_FINDING_CATEGORIES = [
  "inferred_contract_gap",
  "trust_boundary_gap",
  "invariant_counterexample",
  "critical_invariant_coverage_gap",
] as const;

/**
 * The grounding rule, stated identically to every design-review pass because
 * every design-review pass is grounded by the same function
 * (`groundDesignFindings`).
 */
const GROUND_EVERY_FINDING =
  "**Ground every finding.** Cite at least one real `affected_files` path and quote the relevant code or name the identifiable declaration and behavior in the evidence. Use line numbers only to navigate; they do not substantiate a finding. A finding that cites no real component is surfaced as ungrounded (quarantined), not admitted as confirmed: point at the code, do not invent paths. A whole-system observation should anchor on the file(s) where the structure is clearest.";

/**
 * The JUDGE's worked example: the whole submission, not the findings half.
 *
 * It is built from the round's REAL identifiers — the round id the prompt
 * already prints and the contributor ids of the perspective files it lists — so
 * a host that copies it and edits the substance still submits ids this round
 * knows. A placeholder id would parse (`z.string().min(1)`) and then fail the
 * adjudication's own reference checks.
 */
function judgeEnvelopeExample(
  roundId: string,
  contributorIds: readonly string[],
  lensExample: string,
  examplePathValue: string,
): string[] {
  const perspective = contributorIds[0] ?? "design_review_conceptual_perspective_1";
  return [
    "```json",
    "{",
    `  "round_id": ${JSON.stringify(roundId)},`,
    '  "findings": [',
    "    {",
    '      "id": "DR-001",',
    '      "title": "Retry limit is enforced in two places that can disagree",',
    `      "category": "${CONCEPTUAL_FINDING_CATEGORIES[0]}",`,
    '      "severity": "high",',
    '      "confidence": "medium",',
    `      "lens": "${lensExample}",`,
    '      "summary": "detailed explanation of the observation and the recommended change",',
    `      "affected_files": [{"path": ${JSON.stringify(examplePathValue)}}],`,
    '      "systemic": true',
    "    }",
    "  ],",
    '  "candidate_dispositions": [',
    "    {",
    `      "candidate_id": ${JSON.stringify(`${perspective}::DR-004`)},`,
    `      "contributor_id": ${JSON.stringify(perspective)},`,
    '      "source_finding_id": "DR-004",',
    '      "disposition": "retained",',
    '      "target_final_finding_ids": ["DR-001"],',
    '      "modification_percent": 20,',
    '      "rationale": "kept the observation, tightened the statement of the disagreement",',
    '      "verification_status": "judge_confirmed",',
    '      "verification_note": "read both enforcement sites and confirmed they read different constants"',
    "    }",
    "  ],",
    '  "final_finding_shares": [',
    "    {",
    '      "final_finding_id": "DR-001",',
    '      "contributors": [',
    "        {",
    `          "contributor_id": ${JSON.stringify(perspective)},`,
    `          "source_candidate_ids": [${JSON.stringify(`${perspective}::DR-004`)}],`,
    '          "contribution_percent": 80,',
    '          "rationale": "raised the observation and supplied both call sites"',
    "        },",
    "        {",
    '          "contributor_id": "design_review_conceptual",',
    '          "source_candidate_ids": [],',
    '          "contribution_percent": 20,',
    '          "rationale": "verified the defect at HEAD and sharpened the title"',
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
    "",
    `Write the literal value, never the list of permitted ones. \`category\` is one of: ${CONCEPTUAL_FINDING_CATEGORIES.join(", ")}. ${LEAD_CATEGORY_RULE} ` +
      "`severity` is one of: critical, high, medium, low, info. `confidence` is one of: high, medium, low. " +
      "`disposition` is one of: retained, merged, rejected. `verification_status` is one of: " +
      "judge_confirmed, asserted, refuted_at_head. `affected_files` cites a real path from the file " +
      "inventory.",
    "",
    `This object is the value of \`${ENVELOPE_RESULT_KEY}\` in the ${ENVELOPE_CONTRACT_VERSION} envelope ` +
      `stated at the end of this prompt — never a sibling of \`${ENVELOPE_RESULT_KEY}\`. Its ` +
      `${JUDGE_RESULT_KEYS.length} keys ${JUDGE_RESULT_PLACEMENTS} are REQUIRED and no others are ` +
      "permitted. The submission is parsed whole: a missing key, an extra key, or one finding that " +
      "fails the contract refuses the entire merge round, and the round's work is lost.",
    "",
    "Do NOT supply `verification_status`, `evidence_lane` or `lead_lineage` ON A FINDING. The tool " +
      "derives all three at ingestion. The `verification_status` above belongs to a CANDIDATE " +
      "DISPOSITION, which is yours to state.",
  ];
}

export const CONCEPTUAL_FINDING_CATEGORIES = [
  "fundamental_approach",
  "core_assumption",
  "structural_risk",
  "architecture_pattern",
  "design_simplification",
  "tool_opportunity",
  "integration",
  "missing_capability",
] as const;

/**
 * Shared finding-output-format block for any conceptual-review prompt.
 *
 * `exampleLines` is the worked example itself, because the judge's envelope is
 * not the perspectives'. The judge submission carries three required top-level
 * keys the others do not — `round_id`, `candidate_dispositions` and
 * `final_finding_shares` — and `ConceptualJudgeSubmissionSchema` is `.strict()`,
 * so the findings-only envelope every pass used to show failed the judge's own
 * parse with three `Required` issues. The prose above it stated all three; the
 * example a host copies contradicted the prose, and the whole merge round was
 * quarantined (owner decision, 2026-09-17).
 */
function conceptualOutputFormat(
  resultsPathNote: string,
  exampleLines: readonly string[],
): string[] {
  return [
    "## Output format",
    "",
    "The example below is only the domain object for `result`. Submit the complete bound review envelope shown at the end of the prompt:",
    "",
    ...exampleLines,
    "",
    GROUND_EVERY_FINDING,
    "",
    resultsPathNote,
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ];
}

/**
 * Render the charter-layer context block (Phase C) for the conceptual passes:
 * the per-subsystem charters the deterministic charter-extraction produced, so
 * the generative reviewer OPINES per-charter — judging the design against the
 * purpose each subsystem is *for*, not just its structure. Each charter carries
 * its disposition: a confident charter is opinable; a low-confidence one must be
 * FLAGGED for human intent input, never opined on (`charterReviewDisposition` —
 * the tool-enforced guard against confident-but-wrong-charter findings).
 *
 * Byte-identical charter-unaware fallback: returns `""` when the register is
 * absent (old bundle), `status:"omitted"` (shallow ceiling — no charter layer),
 * or carries no surviving charters. The conceptual renderers append this block
 * only when it is non-empty, so a charter-free run renders exactly the prompt it
 * rendered before Phase C threaded the register in. Consumes the register
 * read-only — no Phase-D (clarification) dependency.
 */
export function renderCharterContext(bundle: ArtifactBundle): string {
  const context = projectConceptualCharterContext(bundle);
  if (context.length === 0) return "";
  const blocks = context.map((correspondence) => {
    const files = uniqueSorted(correspondence.accounts.flatMap((account) => account.files));
    const accountLines = correspondence.accounts.map((account) => {
      const disposition = account.disposition === "flag_for_human"
        ? " — LOW-CONFIDENCE account: FLAG for human intent input, do NOT opine on it"
        : "";
      return `  - [${account.kind}] ${account.purpose}${disposition}`;
    });
    const scope = files.length > 0 ? files.join(", ") : "(no scoped files)";
    return [`- **${correspondence.correspondence_id}** (files: ${scope})`, ...accountLines].join("\n");
  });

  return [
    "### Subsystem charters (what each part is FOR)",
    "",
    "The charter layer recorded, per corresponding goal, each channel's account of its purpose in *telos* terms — `stated` (testimony: docs + comments), `structural` (intent frozen into the code's organization), `revealed` (what the code actually optimizes for) — held side by side, never merged. Opine PER ACCOUNT: judge whether the design delivers the purpose each account claims, and surface where a subsystem's structure works against its own charter. Where an account is marked LOW-CONFIDENCE, flag the gap for human intent confirmation instead of opining.",
    "",
    ...blocks,
    "",
  ].join("\n");
}

/**
 * How the dependency graph below was actually EXTRACTED.
 *
 * Empty when every requested analyzer ran, so a clean run's prompt is
 * byte-identical to the prompt it rendered before this block existed. When an
 * analyzer was requested and could not run, the lane is told BY NAME which
 * language lost parser-grade extraction and that the weaker regex floor stood in
 * — otherwise a lane reasoning over the graph is silently reasoning over a
 * degraded one, which is precisely what happened when `web-tree-sitter` failed
 * to install for `html` and `css` and no prompt disclosed it.
 */
function renderGraphProvenance(bundle: ArtifactBundle): string[] {
  const degraded = degradedAnalyzerEntries(bundle.analyzer_capability);
  if (degraded.length === 0) return [];
  return [
    "### Graph provenance — READ THIS BEFORE TRUSTING THE GRAPH",
    "",
    `Parser-grade extraction was requested and could NOT run for ${degraded.length} language analyzer(s); ` +
      "the weaker deterministic regex floor was used for those files instead. The dependency graph " +
      "is therefore INCOMPLETE for them — treat a missing edge in these languages as unknown, not as absent, " +
      "and do not raise a finding whose only evidence is that the graph shows no connection:",
    "",
    ...degraded.map(
      (entry) =>
        `- \`${entry.id}\`${entry.note ? ` — ${entry.note}` : " — the analyzer dependency did not resolve."}`,
    ),
    "",
  ];
}

/** Machine-derived evidence shared by the lanes, never their arguments or verdicts. */
export interface DesignReviewRecon {
  structuralContext: string;
  charterContext: string;
  deepBrief: string;
  deepEvidence: { filename: string; label: string; text: string };
  fileMap: ReviewFileMapContext;
}

export function prepareDesignReviewRecon(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
): DesignReviewRecon {
  const startingPoints = selectStartingPoints(bundle, resolveMaxUnits(bundle, options));
  const fileMap = fileMapContextFor(bundle, startingPoints);
  // Only the starting-point units are named in the prompt. The complete index
  // is reference material: include all manifest paths, including unassigned
  // ones, without implying that listed or excluded files are primary targets.
  const units = bundle.unit_manifest?.units ?? [];
  const inventory = bundle.repo_manifest?.files ?? [];
  if (inventory.length > 0 || units.length > 0) {
    const assigned = new Set(units.flatMap(unit => unit.files));
    const excluded = new Set(inventory.filter(file => file.excluded).map(file => file.path));
    const primary = new Set(designReviewPrimaryFiles(inventory.map(file => file.path), bundle.intent_checkpoint, excluded));
    fileMap.contextFiles.push({
      filename: "design-review-file-inventory.json",
      label: "Complete design-review file inventory (look up specific units or paths as needed)",
      text: JSON.stringify({
        units: Object.fromEntries(units.map(unit => [unit.unit_id, uniqueSorted(unit.files)])),
        unassigned: uniqueSorted(inventory.map(file => file.path).filter(path => !assigned.has(path))),
        excluded: uniqueSorted(inventory.map(file => file.path).filter(path => !primary.has(path))),
      }, null, 2) + "\n",
    });
  }
  const { header, details, orientation, graphProvenance } = renderStructuralContext(
    bundle, startingPoints, fileMap, options.lenses ?? resolveIntentLensSelection(bundle.intent_checkpoint?.lens_selection),
  );
  const charterContext = renderCharterContext(bundle);
  return {
    structuralContext: [header, details(), orientation].join("\n"),
    charterContext,
    deepBrief: [
      header,
      "Read **Unit structure** in the shared deep-review evidence to check the reporting scope of candidate units. Look up relevant units in the separate inventory and call-site maps where available.",
      "Use **Critical flows**, **Externally reachable surfaces**, and **Dependency graph** to trace behavior. Consult **Deterministic structural findings** and **Risk profile** for leads, not verdicts.",
      ...(charterContext ? ["Read **Subsystem charters** for the units you investigate; the charter's confidence and competing accounts matter."] : []),
      "Verify conclusions in frozen source. Read the relevant sections, not the entire evidence file by default.",
      "",
      orientation,
    ].join("\n"),
    deepEvidence: {
      filename: "design-review-shared-evidence.md",
      label: "Shared deep-review evidence (consult the sections in the order named in the prompt)",
      text: ["# Shared deep-review evidence", "", ...graphProvenance, details(Infinity), charterContext].join("\n"),
    },
    fileMap,
  };
}

export function renderSharedStructuralContext(bundle: ArtifactBundle, maxUnits: number): string {
  return prepareDesignReviewRecon(bundle, { max_units: maxUnits }).structuralContext;
}

function renderStructuralContext(bundle: ArtifactBundle, startingPoints: StartingPoints, fileMap: ReviewFileMapContext, lenses: readonly string[] | undefined) {
  const deterministicFindings = bundle.design_assessment?.findings ?? [];
  const prioritizedReadingList = buildPrioritizedReadingList(startingPoints);

  // Bind the same complete semantic projection that controls review staleness,
  // including entries omitted by the human-readable summaries below. Cosmetic
  // timestamps and provenance stay outside identity under that existing policy.
  const inputRevision = designReviewInputRevision(bundle);

  const graphProvenance = renderGraphProvenance(bundle);
  const header = [
    "## Project context",
    `Structural input revision: ${inputRevision}`,
    "",
    `Repository: ${bundle.repo_manifest?.repository?.name ?? "unknown"}`,
    "",
    ...graphProvenance,
  ].join("\n");
  const inventory = [
    // The summary only: the complete map reaches the lane as a read-only context
    // files its emission site binds.
    ...fileMap.summaryLines,
    "### File inventory",
    "",
    summarizeFiles(bundle),
    ...(fileMap.contextFiles.some(file => file.filename === "design-review-file-inventory.json") ? [
      "The complete file inventory is a read-only context file. Look up the specific unit or path you need; do not reload or re-list the whole repository. Use the shared call-site map where it covers your target; otherwise trace the relevant dependencies in frozen source. These inputs do not substitute for your own source checks or judgment.",
    ] : []),
    "",
  ];
  const graphDetails = [
    "### Dependency graph",
    "",
    summarizeGraph(bundle),
    "",
    "### Externally reachable surfaces",
    "",
    summarizeSurfaces(bundle),
    "",
    "### Critical flows",
    "",
    summarizeFlows(bundle),
    "",
    "### Risk profile",
    "",
    summarizeRisk(bundle),
    "",
    "### Deterministic structural findings",
    "",
    formatDeterministicFindings(deterministicFindings, bundle.graph_bundle?.node_metrics, lenses),
    "",
  ];
  const orientation = [
    "### Starting points (orient, then roam)",
    "",
    `This short list and its map do not limit the review. Any unit marked [in scope] in Unit structure is reviewable, including units absent from the starting points and map. Excluded units are dependency context only, not primary review targets. Follow the relevant source paths; you need not read every file.`,
    "",
    prioritizedReadingList,
    "",
  ].join("\n");
  const details = (unitLimit?: number) => [
    ...inventory,
    "### Unit structure",
    "",
    summarizeUnits(bundle, unitLimit),
    "",
    ...graphDetails,
  ].join("\n");
  return { header, details, orientation, graphProvenance };
}

/**
 * Contract-review prompt (adversarial pass).
 * Infers existing contracts from the codebase and attacks them with counterexamples.
 * Categories: inferred_contract_gap, trust_boundary_gap, invariant_counterexample,
 * critical_invariant_coverage_gap.
 */
export function renderContractReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
  recon = prepareDesignReviewRecon(bundle, options),
): string {

  return [
    "# Project contract review (adversarial pass)",
    "",
    "You are performing the **contract-assessment** pass on this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to infer existing contracts from the repository and attack them adversarially with concrete counterexamples.",
    "",
    recon.structuralContext,
    ...renderLensScope(options),
    "## Contract assessment instructions",
    "",
    "- Infer existing contracts from the repository artifacts and code you inspect: invariants, trust boundaries, preconditions, postconditions, data lifecycle obligations, and critical-flow guarantees.",
    "- Attack those inferred contracts with concrete counterexamples. Report evidenced gaps where the code appears to rely on an invariant or boundary that is missing, unenforced, unclear, or uncovered for a critical flow.",
    "- Be adversarial: look for cases where the contract is violated, not just cases where it is satisfied.",
    "- Stay observational: do not invent a new contract DSL, write a remediation plan, remediate code, or turn the audit into an implementation pipeline.",
    "",
    "## Output format",
    "",
    "The example below is only the domain object for `result`. Submit the complete bound review envelope shown at the end of the prompt:",
    "",
    ...findingsEnvelopeExample(
      CONTRACT_FINDING_CATEGORIES,
      exampleLens(options),
      examplePath(bundle),
    ),
    "",
    // The grounding rule is stated here as well as in `conceptualOutputFormat`
    // because the contract pass IS grounded: `nextStepHelpers` runs
    // `groundDesignFindings` over `contract_findings` exactly as it does over
    // the conceptual ones. The rule was stated to the conceptual reviewer only,
    // so the contract reviewer was judged by a rule it was never told.
    GROUND_EVERY_FINDING,
    "",
    // Where the object goes (and what to do when this lane cannot write files)
    // is stated once, by the lane materializer's results-path footer.
    "Use finding IDs starting with DR-001.",
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ].join("\n");
}

/**
 * Conceptual-design review prompt (generative pass — shallow / single agent).
 * Produces broad architectural and design improvement observations.
 * Categories: see CONCEPTUAL_FINDING_CATEGORIES.
 *
 * The deep multi-perspective variant is real dispatch fan-out, not an in-prompt
 * instruction — see `renderConceptualPerspectivePrompt` /
 * `renderConceptualJudgePrompt`.
 */
export function renderConceptualReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
  recon = prepareDesignReviewRecon(bundle, options),
): string {
  const { charterContext } = recon;

  return [
    "# Project conceptual design review (generative pass)",
    "",
    "You are performing the **conceptual-design-critique** pass on this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to provide generative observations about broader architecture ideas that static analysis cannot produce.",
    "",
    recon.structuralContext,
    ...renderLensScope(options),
    ...(charterContext ? [charterContext] : []),
    ...conceptualCritiqueInstructions(),
    ...conceptualOutputFormat(
      "Use finding IDs starting with DR-001.",
      findingsEnvelopeExample(
        CONCEPTUAL_FINDING_CATEGORIES,
        exampleLens(options),
        examplePath(bundle),
      ),
    ),
  ].join("\n");
}

const OUTSIDE_IN_REVIEW = [
  "## Start outside-in: purpose, alternatives, then implementation",
  "",
  "1. **State the problem without inheriting the solution.** Read only enough project documentation and stated intent to identify one or two consequential user outcomes and their actual constraints. Separate requirements from assumptions and implementation choices. Flag uncertain intent rather than inventing constraints.",
  "2. **Look outside before reading implementation details or audit findings.** When public lookup is available and authorized, use generic problem and constraint terms to find how comparable projects, established standards, or existing tools solve it. Read primary sources and cite what they actually support. Do not expose private identifiers, source, or project data in external queries. If you already know the implementation, write down independent alternatives before comparing. If lookup is unavailable or not authorized, label alternatives as unverified hypotheses and do not claim external validation.",
  "3. **Then verify fit in frozen source.** After the alternatives are written down, read Unit structure and the pertinent Subsystem charters in the shared evidence; consult the inventory, call sites, flows, graph and its provenance, or analyzer evidence as needed. Use the local reading, scope and grounding rules below. Compare keeping, deleting, simplifying, or replacing the current approach; assess fit to the stated constraints, what is gained or lost, and the smallest reversible check that would resolve the main uncertainty. A newer tool is not a reason to replace working code.",
  "4. **Report only consequential options.** Use the existing conceptual categories (for example, fundamental_approach, design_simplification, or tool_opportunity). For an alternative to an otherwise working design, label the summary as a design option, not a defect. Cite both the local design it would change and any external evidence; state the main trade-off and a deciding check. Do not invent a failure to justify the option. No recommendation is better than a forced one.",
  "",
] as const;

/**
 * One perspective's conceptual-review prompt (deep fan-out). Each perspective
 * runs in an independent context that reviews *only* through its
 * assigned value system and must not see the other perspectives' output — a
 * separate judge merges them. This is the real fan-out that replaces the old
 * single-agent "imagine several perspectives" instruction.
 */
export function renderConceptualPerspectivePrompt(
  bundle: ArtifactBundle,
  perspective: ConceptualPerspective,
  index: number,
  total: number,
  options: DesignReviewOptions = {},
  recon = prepareDesignReviewRecon(bundle, options),
): string {
  const outsideIn = perspective.name === OUTSIDE_IN_PERSPECTIVE_NAME;
  return [
    "# Conceptual design review",
    "",
    `You are **one of ${total} independent reviewers**, each assigned a different value system. You will NOT see the other reviewers' output; a separate judge will merge the findings. Review the whole in-scope codebase only through the perspective assigned below. Do not try to cover the other angles.`,
    "",
    ...(outsideIn ? [] : [recon.deepBrief, ...renderLensScope(options)]),
    `## Your perspective: ${perspective.name} (perspective ${index + 1} of ${total})`,
    "",
    perspective.lens,
    "",
    "You may sharpen or extend this lens to fit this codebase's character and domain, but stay in character.",
    "",
    ...(outsideIn ? [...OUTSIDE_IN_REVIEW, ...renderLensScope(options)] : []),
    ...conceptualCritiqueInstructions(),
    ...conceptualOutputFormat(
      "Report findings *from your perspective only*. Use finding IDs starting with DR-001.",
      findingsEnvelopeExample(
        CONCEPTUAL_FINDING_CATEGORIES,
        exampleLens(options),
        examplePath(bundle),
      ),
    ),
  ].join("\n");
}

/**
 * The independent judge prompt (deep fan-out). The judge is a fresh agent —
 * never one of the perspective authors — that reads every perspective's
 * findings, merges and deduplicates them, resolves contradictions, drops
 * low-confidence observations no other perspective corroborates, and writes the
 * single merged conceptual-review result the orchestrator ingests.
 */
export function renderConceptualJudgePrompt(
  bundle: ArtifactBundle,
  perspectiveResults: Array<{
    name: string;
    path: string;
    contributor_id: string;
  }>,
  roundId: string,
  options: DesignReviewOptions = {},
  recon = prepareDesignReviewRecon(bundle, options),
): string {
  const sources = perspectiveResults.map(
    (p, i) =>
      `${i + 1}. **${p.name}** — contributor \`${p.contributor_id}\` — \`${p.path}\``,
  );

  return [
    "# Conceptual design review — judge / merge pass",
    "",
    `You are an **independent judge and final reviewer**. Several reviewers each examined this project through a different value system and wrote their findings to separate files. You did **not** author any of them — your job is to evaluate them on merit, merge them into one ranked, deduplicated result, AND add anything significant they collectively missed.`,
    "",
    // The judge can add missed issues, so it needs the same scope and evidence.
    recon.deepBrief,
    ...renderLensScope(options),
    "## Perspective result files",
    "",
    "Read each of these review-submission/v1 JSON envelopes. The domain findings are in `result.findings`; `review` declares the reviewer context. If a perspective declares degraded or unavailable, stop and request an independent replacement instead of treating it as completed review:",
    "",
    ...sources,
    "",
    "## Judging instructions",
    "",
    "- **Merge** all findings into a single list.",
    "- **Deduplicate**: collapse findings that describe the same underlying observation, even if worded differently. Keep the clearest statement and note corroboration in the summary.",
    "- **Resolve contradictions**: when two perspectives disagree, keep the better-evidenced position; if genuinely unresolved, keep it and say so.",
    "- **Rank** by impact and actionability.",
    "- **Judge on merit, not consensus.** Evaluate each finding on its own evidence, impact, and actionability. Do NOT drop a finding solely because only one perspective raised it — a lone but well-reasoned or high-impact observation must survive. Cross-perspective corroboration only RAISES confidence; it is never a survival requirement.",
    ...(perspectiveResults.some(p => p.name === OUTSIDE_IN_PERSPECTIVE_NAME) ? [
      "- **Distinguish design options from defects.** A well-grounded alternative to working code can survive on its merits. Keep its design-option label, relevant local and external evidence, main trade-off and deciding check. Do not claim the current code is defective simply because another approach exists. Verify the named local premise for an option; if it is absent or already implemented, reject the candidate rather than reporting it as new.",
    ] : []),
    "- **Drop only genuine noise:** vague, unactionable, unsupported, or out-of-scope assertions — regardless of how many perspectives raised them.",
    "- **Reject what HEAD has already fixed.** The grounds above are all about the FORM of an assertion, so a well-argued, actionable, in-scope claim whose defect is simply NOT THERE matches none of them. Check each candidate's named defect against the current code. A candidate whose defect is absent, already remediated, or otherwise refuted at HEAD is `rejected` with `verification_status: \"refuted_at_head\"` — never merged at a high `modification_percent`, which records a real finding where there is none.",
    "- **Flag what the perspectives MISSED.** You are the final reviewer, not only a merger. If, across every perspective, a significant whole-system issue went unraised — a shared assumption none of them questioned, a structural risk no lens covered, a doubt about whether the fundamental approach is even right — add it as a finding, mark its title with `(judge-added)`, and hold it to the same evidence and grounding bar as any other finding. Add only what genuinely matters and is genuinely absent; do not pad.",
    "",
    "- **Account for every candidate.** A candidate is one perspective finding, identified as `<contributor_id>::<source finding id>`. Record exactly one `retained`, `merged`, or `rejected` disposition for every candidate. Retained/merged candidates name every final finding they feed; rejected candidates name none. State a 0-100 `modification_percent` estimating how much the source changed in the final result, plus a concrete transformation/rejection rationale.",
    "- **State what you verified, per candidate.** Every candidate carries a `verification_status`: `judge_confirmed` (you checked the named defect against the current code and it holds), `asserted` (you did not check), or `refuted_at_head` (you checked and it is absent or already fixed). A `judge_confirmed` or `refuted_at_head` candidate ALSO carries a `verification_note` saying what you checked and what you found; an `asserted` candidate must NOT carry one. `asserted` is the honest default — do not claim a check you did not perform.",
    "- **Attribute every final finding.** Allocate contributor shares totaling exactly 100%. Each contributor appears exactly once per final finding: when several of that contributor's candidates feed the same finding, put all their IDs in one `source_candidate_ids` array and allocate one combined share. Perspective shares cite their candidate IDs. Include exactly one explicit `design_review_conceptual` judge share (zero is allowed when the judge only selected unchanged work; positive when the judge added or materially synthesized content). State a rationale for every share.",
    `- Set \`${ENVELOPE_RESULT_KEY}.round_id\` to exactly \`${roundId}\`. In the SAME \`${ENVELOPE_RESULT_KEY}\` object as \`${ENVELOPE_RESULT_KEY}.findings\`, include \`candidate_dispositions\` entries with \`candidate_id\`, \`contributor_id\`, \`source_finding_id\`, \`disposition\`, \`target_final_finding_ids\`, \`modification_percent\`, \`rationale\`, \`verification_status\`, and \`verification_note\` (only when the status is not \`asserted\`); and \`final_finding_shares\` entries with \`final_finding_id\` plus \`contributors\`, each carrying \`contributor_id\`, \`source_candidate_ids\`, \`contribution_percent\`, and \`rationale\`.`,
    ...conceptualOutputFormat(
      "Produce ONE merged, ranked object. Renumber finding IDs sequentially from DR-001.",
      judgeEnvelopeExample(
        roundId,
        perspectiveResults.map((p) => p.contributor_id),
        exampleLens(options),
        examplePath(bundle),
      ),
    ),
  ].join("\n");
}
