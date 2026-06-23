import type { ArtifactBundle } from "../io/artifacts.js";
import type { Finding } from "../types.js";
import {
  deriveUnitScopeDisposition,
  type UnitScopeDisposition,
} from "./intentScopeDisposition.js";

export { deriveUnitScopeDisposition, type UnitScopeDisposition };

/** Render the `[in scope]` / `[excluded: reason]` tag for a unit disposition. */
function scopeTag(disposition: UnitScopeDisposition): string {
  return disposition.kind === "excluded"
    ? `[excluded: ${disposition.reason}]`
    : "[in scope]";
}

function summarizeUnits(bundle: ArtifactBundle): string {
  const units = bundle.unit_manifest?.units ?? [];
  if (units.length === 0) return "No units identified.";

  const checkpoint = bundle.intent_checkpoint;
  const lines = units.map((unit) => {
    const lenses = unit.required_lenses.join(", ") || "none";
    const tag = scopeTag(deriveUnitScopeDisposition(unit.files, checkpoint));
    return `- ${unit.unit_id} ${tag} (${unit.files.length} files, lenses: ${lenses})`;
  });

  return [
    `${units.length} units:`,
    ...lines.slice(0, 40),
    ...(units.length > 40 ? [`  ... and ${units.length - 40} more`] : []),
  ].join("\n");
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

function summarizeFlows(bundle: ArtifactBundle, max = 15): string {
  const flows = bundle.critical_flows?.flows ?? [];
  if (flows.length === 0) return "No critical flows identified.";

  const shown = flows.slice(0, max);
  const lines = shown.map(
    (flow) =>
      `- ${flow.name}: ${flow.paths.length} files, concerns: ${flow.concerns.join(", ") || "none"}`,
  );

  return [
    `${flows.length} critical flows:`,
    ...lines,
    ...(flows.length > max ? [`  ... and ${flows.length - max} more`] : []),
  ].join("\n");
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

function buildPrioritizedReadingList(
  bundle: ArtifactBundle,
  maxUnits: number,
): string {
  const items = bundle.risk_register?.items ?? [];
  const units = bundle.unit_manifest?.units ?? [];

  if (items.length === 0 && units.length === 0) {
    return "No risk or unit data available; read the repository root files to orient yourself.";
  }

  // Build a map from unit_id → file list for fast lookup
  const unitFiles = new Map<string, string[]>();
  for (const unit of units) {
    unitFiles.set(unit.unit_id, unit.files);
  }

  // Sort risk items by score descending, then take the top-N
  const sorted = [...items].sort((a, b) => b.risk_score - a.risk_score);
  const top = sorted.slice(0, maxUnits);

  if (top.length === 0) {
    // Fall back to listing all units if no risk data
    const allUnits = units.slice(0, maxUnits);
    const lines = allUnits.map((u) => `- **${u.unit_id}** — ${u.files.join(", ")}`);
    return [
      `Top ${allUnits.length} unit(s) (no risk scores available):`,
      ...lines,
    ].join("\n");
  }

  const lines = top.map((item) => {
    const files = unitFiles.get(item.unit_id);
    const fileList = files && files.length > 0 ? files.join(", ") : "(files unknown)";
    return `- **${item.unit_id}** (risk score: ${item.risk_score}) — ${fileList}`;
  });

  return [
    `Top ${top.length} highest-risk unit(s) by risk score (out of ${items.length} total):`,
    ...lines,
  ].join("\n");
}

function summarizeSurfaces(bundle: ArtifactBundle, max = 20): string {
  const surfaces = bundle.surface_manifest?.surfaces ?? [];
  if (surfaces.length === 0) return "No externally reachable surfaces identified.";

  const shown = surfaces.slice(0, max);
  const lines = shown.map(
    (surface) =>
      `- ${surface.id} (${surface.kind}): ${surface.entrypoint}${surface.methods?.length ? ` [${surface.methods.join(", ")}]` : ""}`,
  );

  return [
    `${surfaces.length} surfaces:`,
    ...lines,
    ...(surfaces.length > max ? [`  ... and ${surfaces.length - max} more`] : []),
  ].join("\n");
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

function formatDeterministicFindings(findings: Finding[], max = 20): string {
  if (findings.length === 0)
    return "No structural issues detected by deterministic analysis.";

  const shown = findings.slice(0, max);
  const lines = shown.map(
    (finding) =>
      `- [${finding.severity}] ${finding.title}: ${finding.summary}`,
  );

  return [
    `${findings.length} structural findings from deterministic analysis:`,
    ...lines,
    ...(findings.length > max ? [`  ... and ${findings.length - max} more`] : []),
  ].join("\n");
}

export interface DesignReviewOptions {
  max_units?: number;
  conceptual_depth?: "shallow" | "deep";
  /**
   * Whether the host can dispatch independent sub-agents. Threaded from the
   * resolved `host_can_dispatch_subagents` handshake (`resolveHostDispatchCapability`),
   * NOT a manual flag. Parity with the remediate contract pipeline: the
   * adversarial design-review passes (contract-assessment / conceptual-critique)
   * MANDATE an independent sub-agent reviewer when true and degrade to an
   * explicit inline self-review instruction when false. Fail-safe: when omitted,
   * the mandate is rendered.
   */
  hostCanDispatchSubagents?: boolean;
}

/**
 * Render the independent-reviewer directive shared by the audit-side adversarial
 * review prompts, mirroring the remediate contract pipeline's 'critique' /
 * 'critic' mandate. Mandate when the host can dispatch (default / fail-safe);
 * degrade to an explicit inline self-review instruction when it provably cannot.
 */
export function renderIndependentReviewerDirective(
  hostCanDispatchSubagents: boolean | undefined,
): string[] {
  // Fail-safe default: undefined ⇒ mandate. A host that genuinely cannot
  // dispatch opts out by passing false explicitly.
  const mandate = hostCanDispatchSubagents !== false;
  if (mandate) {
    return [
      "## Independent review — MANDATORY",
      "",
      "This is an adversarial review: its value comes from a reviewer who is **not** the author of the design under review. You MUST dispatch this review to a fresh, independent sub-agent that did not author the work and does not see the author's reasoning. An author grading their own work systematically misses the gaps this pass exists to catch. Do NOT perform this review inline yourself.",
      "",
    ];
  }
  return [
    "## Independent review — degraded to inline self-review",
    "",
    "This host reported it cannot dispatch an independent sub-agent, so this adversarial review runs inline. Compensate deliberately: adopt a fresh adversarial stance, set aside the author's reasoning, and attack the design as a hostile outside reviewer would. (When sub-agent dispatch is available this review is MANDATED to an independent agent — inline self-review is the degraded fallback, not the intended path.)",
    "",
  ];
}

/**
 * A conceptual-review perspective: a deliberately narrow value system one
 * independent reviewer adopts. The deep conceptual pass fans these out to real
 * parallel subagents (one perspective each), then merges via an independent
 * judge. Provider-neutral — a perspective is a *lens*, never a model.
 */
export interface ConceptualPerspective {
  name: string;
  /** The value system this reviewer judges the codebase through. */
  lens: string;
}

/**
 * Built-in conceptual perspectives, ordered most-to-least commonly useful. The
 * deep fan-out takes the first `perspectives` of these. Each is a maximally
 * dissimilar value system so the union covers angles no single pass would. A
 * reviewer may sharpen its lens to the codebase, but stays in character.
 */
export const CONCEPTUAL_PERSPECTIVES: readonly ConceptualPerspective[] = [
  {
    name: "Pragmatist",
    lens:
      "Does this actually work for users? What's the shortest path to value? Flag anything that adds ceremony or indirection without earning its keep.",
  },
  {
    name: "Mathematician seeking elegance",
    lens:
      "Minimal complexity, orthogonal abstractions, no redundancy. Flag overlapping concepts that should be unified and abstractions that fail to compose.",
  },
  {
    name: "Short attention span",
    lens:
      "Frustrated by anything taking >30 seconds to understand. If a design can't be explained simply, it's too complex. Flag cognitive-load hotspots and implicit knowledge.",
  },
  {
    name: "Novelty-seeker",
    lens:
      "Always hunting for the latest tool, pattern, or library that could replace hand-rolled machinery. Flag wheels being reinvented and standards being ignored.",
  },
  {
    name: "Adversary",
    lens:
      "What could go wrong, what's fragile, what breaks under pressure or at scale? Flag failure modes the happy path quietly assumes away.",
  },
  {
    name: "Maintainer inheriting this cold",
    lens:
      "A new engineer six months from now with no context. Flag what would take longest to learn, what's implicit, and what has no obvious entry point.",
  },
  {
    name: "Minimalist",
    lens:
      "What could be deleted entirely? Flag features, layers, and options that exist but earn little, and capabilities that duplicate one another.",
  },
];

/** Default number of deep-review perspectives when the host does not specify. */
export const DEFAULT_CONCEPTUAL_PERSPECTIVES = 5;

/**
 * Clamp a requested perspective count into the supported range: at least 2
 * (one perspective is just a shallow review) and at most the number of built-in
 * perspectives. Non-finite / undefined ⇒ the default.
 */
export function clampPerspectiveCount(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_CONCEPTUAL_PERSPECTIVES;
  }
  return Math.max(2, Math.min(CONCEPTUAL_PERSPECTIVES.length, Math.floor(requested)));
}

/** The first `count` (clamped) built-in perspectives for a deep fan-out. */
export function selectPerspectives(count?: number): ConceptualPerspective[] {
  return CONCEPTUAL_PERSPECTIVES.slice(0, clampPerspectiveCount(count));
}

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
    "The structural context above is a map to orient you — it is NOT your reading list, and it is not where the deep problems will be obvious. Before forming conclusions:",
    "",
    "- **Read the project's own documentation first** — its README, anything under `docs/`, design notes, and any `CLAUDE.md`/agent-instruction files — to learn what this project is *trying* to be and why. Understand the intent before you judge the execution.",
    "- **Then roam the actual code freely.** Read whole files, follow imports and call paths wherever they lead, and build your own mental model the way a new senior engineer would. Do NOT confine yourself to the highest-risk units — emergent, whole-system problems live in the connections between ordinary-looking parts, which no per-unit risk score surfaces.",
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

/** Shared finding-output-format block for any conceptual-review prompt. */
function conceptualOutputFormat(resultsPathNote: string): string[] {
  return [
    "## Output format",
    "",
    "Produce a JSON array of findings. Each finding must conform to:",
    "",
    "```json",
    "{",
    '  "id": "DR-001",',
    '  "title": "short descriptive title",',
    '  "category": "one of: fundamental_approach, core_assumption, structural_risk, architecture_pattern, design_simplification, tool_opportunity, integration, missing_capability",',
    '  "severity": "one of: critical, high, medium, low, info",',
    '  "confidence": "one of: high, medium, low",',
    '  "lens": "architecture",',
    '  "summary": "detailed explanation of the observation and the recommended change",',
    '  "affected_files": [{"path": "relevant/file.ts"}],',
    '  "systemic": true',
    "}",
    "```",
    "",
    "**Ground every finding.** Cite at least one real `affected_files` path that exists in this repository — the component your observation is actually about. A finding that cites no real component is surfaced as ungrounded (quarantined), not admitted as confirmed: point at the code, do not invent paths. A whole-system observation should anchor on the file(s) where the structure is clearest.",
    "",
    resultsPathNote,
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ];
}

/**
 * Render the shared structural context block that is identical for both the
 * contract-review and conceptual-review passes. Placing it first in both
 * prompts makes it cache-eligible when the same bundle is used for both agents.
 */
export function renderSharedStructuralContext(
  bundle: ArtifactBundle,
  maxUnits: number,
): string {
  const deterministicFindings = bundle.design_assessment?.findings ?? [];
  const prioritizedReadingList = buildPrioritizedReadingList(bundle, maxUnits);

  return [
    "## Project context",
    "",
    `Repository: ${bundle.repo_manifest?.repository?.name ?? "unknown"}`,
    "",
    "### File inventory",
    "",
    summarizeFiles(bundle),
    "",
    "### Unit structure",
    "",
    summarizeUnits(bundle),
    "",
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
    formatDeterministicFindings(deterministicFindings),
    "",
    "### Starting points (orient, then roam)",
    "",
    `Use the ${maxUnits} highest-risk units below to orient yourself, then follow the code wherever it leads. You need not read every file, but do NOT confine yourself to this list — the most important problems often live in the connections between ordinary-looking parts that no per-unit risk score flags.`,
    "",
    prioritizedReadingList,
    "",
  ].join("\n");
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
): string {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;

  return [
    "# Project contract review (adversarial pass)",
    "",
    "You are performing the **contract-assessment** pass on this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to infer existing contracts from the repository and attack them adversarially with concrete counterexamples.",
    "",
    renderSharedStructuralContext(bundle, maxUnits),
    "## Contract assessment instructions",
    "",
    "- Infer existing contracts from the repository artifacts and code you inspect: invariants, trust boundaries, preconditions, postconditions, data lifecycle obligations, and critical-flow guarantees.",
    "- Attack those inferred contracts with concrete counterexamples. Report evidenced gaps where the code appears to rely on an invariant or boundary that is missing, unenforced, unclear, or uncovered for a critical flow.",
    "- Be adversarial: look for cases where the contract is violated, not just cases where it is satisfied.",
    "- Stay observational: do not invent a new contract DSL, write a remediation plan, remediate code, or turn the audit into an implementation pipeline.",
    "",
    "## Output format",
    "",
    "Produce a JSON array of findings. Each finding must conform to:",
    "",
    "```json",
    "{",
    '  "id": "DR-001",',
    '  "title": "short descriptive title",',
    '  "category": "one of: inferred_contract_gap, trust_boundary_gap, invariant_counterexample, critical_invariant_coverage_gap",',
    '  "severity": "one of: critical, high, medium, low, info",',
    '  "confidence": "one of: high, medium, low",',
    '  "lens": "architecture",',
    '  "summary": "detailed explanation of the observation and the recommended change",',
    '  "affected_files": [{"path": "relevant/file.ts"}],',
    '  "systemic": true',
    "}",
    "```",
    "",
    "Write the JSON array to the contract review results path provided below. Use finding IDs starting with DR-001.",
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ].join("\n");
}

/**
 * Conceptual-design review prompt (generative pass — shallow / single agent).
 * Produces broad architectural and design improvement observations.
 * Categories: tool_opportunity, architecture_pattern, design_simplification,
 * integration, missing_capability.
 *
 * The deep multi-perspective variant is real dispatch fan-out, not an in-prompt
 * instruction — see `renderConceptualPerspectivePrompt` /
 * `renderConceptualJudgePrompt`.
 */
export function renderConceptualReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
): string {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;

  return [
    "# Project conceptual design review (generative pass)",
    "",
    "You are performing the **conceptual-design-critique** pass on this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to provide generative observations about broader architecture ideas that static analysis cannot produce.",
    "",
    renderSharedStructuralContext(bundle, maxUnits),
    ...conceptualCritiqueInstructions(),
    ...conceptualOutputFormat(
      "Write the JSON array to the conceptual review results path provided below. Use finding IDs starting with DR-001.",
    ),
  ].join("\n");
}

/**
 * One perspective's conceptual-review prompt (deep fan-out). Each perspective
 * is dispatched to an independent subagent that reviews *only* through its
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
): string {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;

  return [
    `# Conceptual design review — perspective ${index + 1} of ${total}: ${perspective.name}`,
    "",
    `You are **one of ${total} independent reviewers**, each assigned a deliberately different value system. You will NOT see the other reviewers' output, and a separate judge agent will merge everyone's findings. Do **not** try to be balanced or cover the other angles — your value is the one perspective no one else takes. Review the whole codebase, but judge it only through your assigned lens.`,
    "",
    `## Your perspective: ${perspective.name}`,
    "",
    perspective.lens,
    "",
    "You may sharpen or extend this lens to fit this codebase's character and domain, but stay in character.",
    "",
    renderSharedStructuralContext(bundle, maxUnits),
    ...conceptualCritiqueInstructions(),
    ...conceptualOutputFormat(
      "Write the JSON array of findings *from your perspective only* to the results path provided below. Use finding IDs starting with DR-001.",
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
  perspectiveResults: Array<{ name: string; path: string }>,
): string {
  const sources = perspectiveResults.map(
    (p, i) => `${i + 1}. **${p.name}** — \`${p.path}\``,
  );

  return [
    "# Conceptual design review — judge / merge pass",
    "",
    `You are an **independent judge and final reviewer**. Several reviewers each examined this project through a different value system and wrote their findings to separate files. You did **not** author any of them — your job is to evaluate them on merit, merge them into one ranked, deduplicated result, AND add anything significant they collectively missed.`,
    "",
    "## Perspective result files",
    "",
    "Read each of these JSON finding arrays:",
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
    "- **Drop only genuine noise:** vague, unactionable, unsupported, or out-of-scope assertions — regardless of how many perspectives raised them.",
    "- **Flag what the perspectives MISSED.** You are the final reviewer, not only a merger. If, across every perspective, a significant whole-system issue went unraised — a shared assumption none of them questioned, a structural risk no lens covered, a doubt about whether the fundamental approach is even right — add it as a finding, mark its title with `(judge-added)`, and hold it to the same evidence and grounding bar as any other finding. Add only what genuinely matters and is genuinely absent; do not pad.",
    "",
    ...conceptualOutputFormat(
      "Write the merged, ranked JSON array to the conceptual review results path provided below. Renumber finding IDs sequentially from DR-001.",
    ),
  ].join("\n");
}

/**
 * Combined fallback prompt for non-dispatch paths: both contract-assessment and
 * conceptual-design-critique sections in a single agent turn.
 */
export function renderDesignReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
): string {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;

  return [
    "# Project design review",
    "",
    "You are reviewing the overall design of this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to provide qualitative observations in two distinct modes: contract assessment for inferred or existing project contracts, and conceptual design critique for broader architecture ideas that static analysis cannot produce.",
    "",
    renderSharedStructuralContext(bundle, maxUnits),
    ...renderIndependentReviewerDirective(options.hostCanDispatchSubagents),
    "## What to assess",
    "",
    `Focus on the ${maxUnits} highest-risk units listed above; you need not read the entire repository, though you may follow any thread that demands more context. Produce findings about:`,
    "",
    "### Contract assessment",
    "",
    "- Infer existing contracts from the repository artifacts and code you inspect: invariants, trust boundaries, preconditions, postconditions, data lifecycle obligations, and critical-flow guarantees.",
    "- Attack those inferred contracts with concrete counterexamples. Report evidenced gaps where the code appears to rely on an invariant or boundary that is missing, unenforced, unclear, or uncovered for a critical flow.",
    "- Use contract-assessment categories such as inferred_contract_gap, trust_boundary_gap, invariant_counterexample, and critical_invariant_coverage_gap when those best describe the finding.",
    "- Stay observational: do not invent a new contract DSL, write a remediation plan, remediate code, or turn the audit into an implementation pipeline.",
    "",
    "### Conceptual design critique",
    "",
    "Ask general, first-principles questions (not a checklist) — read the project's own docs, then roam the real code:",
    "- **Is the fundamental approach the right one?** What would a clean-sheet redesign do differently, and why?",
    "- **What core assumption does the design rest on, and is it sound?** What breaks if it is wrong?",
    "- **Where is the deepest structural risk** — the place the *shape* of the system will hurt most as it grows or changes hands?",
    "- **Does the structure match the problem,** or do abstractions and boundaries cut across it?",
    "- **What is the design optimizing for, and is that the right trade-off?** What is missing that it will eventually need?",
    "",
    "## Output format",
    "",
    "Produce a JSON array of findings. Each finding must conform to:",
    "",
    "```json",
    "{",
    '  "id": "DR-001",',
    '  "title": "short descriptive title",',
    '  "category": "one of: inferred_contract_gap, trust_boundary_gap, invariant_counterexample, critical_invariant_coverage_gap, tool_opportunity, architecture_pattern, design_simplification, integration, missing_capability",',
    '  "severity": "one of: critical, high, medium, low, info",',
    '  "confidence": "one of: high, medium, low",',
    '  "lens": "architecture",',
    '  "summary": "detailed explanation of the observation and the recommended change",',
    '  "affected_files": [{"path": "relevant/file.ts"}],',
    '  "systemic": true',
    "}",
    "```",
    "",
    "Write the JSON array to the design review results path provided below. Use finding IDs starting with DR-001.",
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ].join("\n");
}
