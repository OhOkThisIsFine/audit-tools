import type { ArtifactBundle } from "../io/artifacts.js";
import type { Finding } from "../types.js";

function summarizeUnits(bundle: ArtifactBundle): string {
  const units = bundle.unit_manifest?.units ?? [];
  if (units.length === 0) return "No units identified.";

  const lines = units.map((unit) => {
    const lenses = unit.required_lenses.join(", ") || "none";
    return `- ${unit.unit_id} (${unit.files.length} files, lenses: ${lenses})`;
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
    "### Prioritised reading list",
    "",
    `Focus on the ${maxUnits} highest-risk units listed below; you need not read the entire repository, though you may follow any thread that demands more context.`,
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
 * Conceptual-design review prompt (generative pass).
 * Produces broad architectural and design improvement observations.
 * Categories: tool_opportunity, architecture_pattern, design_simplification,
 * integration, missing_capability.
 */
export function renderConceptualReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
): string {
  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;
  const isDeep = options.conceptual_depth === "deep";

  const deepSection = isDeep ? [
    "## Deep review: multi-perspective fan-out",
    "",
    "This review uses **deep** conceptual depth. Instead of a single review pass,",
    "fan out 3–5 independent reviewers with maximally dissimilar perspectives,",
    "then compile the results via a judge.",
    "",
    "**Principle:** maximize dissimilarity between perspectives. Each reviewer",
    "should approach the codebase from a fundamentally different value system so",
    "the union of their observations covers angles no single perspective would.",
    "",
    "**Example perspectives** (choose or invent based on codebase character):",
    "",
    "- A **pragmatist**: “Does this actually work for users? What’s the shortest",
    "  path to value?”",
    "- A **mathematician seeking elegance**: minimal complexity, orthogonal",
    "  abstractions, no redundancy.",
    "- Someone with a **short attention span**: frustrated by anything taking",
    "  >30 seconds to understand. If the design can’t be explained simply, it’s",
    "  too complex.",
    "- A **novelty-seeker**: always looking for the latest tool, pattern, or",
    "  library that could replace hand-rolled machinery.",
    "- An **adversary**: what could go wrong, what’s fragile, what breaks under",
    "  pressure or at scale?",
    "",
    "These are examples, not a fixed set. Choose or invent perspectives that",
    "fit this specific codebase’s character and domain.",
    "",
    "**Process:**",
    "1. Spawn 3–5 independent sub-agents, each given one perspective and the",
    "   shared structural context below. They must not see each other’s output.",
    "2. Collect their findings.",
    "3. Run a judge agent that merges, deduplicates, and ranks the combined",
    "   findings. The judge resolves contradictions and drops low-confidence",
    "   observations that no other perspective corroborates.",
    "4. The judge’s merged output is the final conceptual review result.",
    "",
  ] : [];

  return [
    "# Project conceptual design review (generative pass)",
    "",
    "You are performing the **conceptual-design-critique** pass on this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to provide generative observations about broader architecture ideas that static analysis cannot produce.",
    "",
    renderSharedStructuralContext(bundle, maxUnits),
    ...deepSection,
    "## Conceptual design critique instructions",
    "",
    "- **Tool and library opportunities**: third-party tools, libraries, or frameworks that would improve the project. Concrete suggestions with rationale, not generic advice.",
    "- **Architecture pattern improvements**: structural changes that would improve extensibility, testability, or maintainability. Consider whether the current abstractions match the problem domain.",
    "- **Design simplification**: areas where the design is over-engineered or where simpler alternatives would work. Conversely, areas that are under-designed for their importance.",
    "- **Integration and generalization**: opportunities to make the project more portable, composable, or protocol-aligned (e.g., MCP, standard APIs, plugin architectures).",
    "- **Missing capabilities**: gaps in the design that would become pain points as the project evolves.",
    "",
    "## Output format",
    "",
    "Produce a JSON array of findings. Each finding must conform to:",
    "",
    "```json",
    "{",
    '  "id": "DR-001",',
    '  "title": "short descriptive title",',
    '  "category": "one of: tool_opportunity, architecture_pattern, design_simplification, integration, missing_capability",',
    '  "severity": "one of: critical, high, medium, low, info",',
    '  "confidence": "one of: high, medium, low",',
    '  "lens": "architecture",',
    '  "summary": "detailed explanation of the observation and the recommended change",',
    '  "affected_files": [{"path": "relevant/file.ts"}],',
    '  "systemic": true',
    "}",
    "```",
    "",
    "Write the JSON array to the conceptual review results path provided below. Use finding IDs starting with DR-001.",
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
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
    "- **Tool and library opportunities**: third-party tools, libraries, or frameworks that would improve the project. Concrete suggestions with rationale, not generic advice.",
    "- **Architecture pattern improvements**: structural changes that would improve extensibility, testability, or maintainability. Consider whether the current abstractions match the problem domain.",
    "- **Design simplification**: areas where the design is over-engineered or where simpler alternatives would work. Conversely, areas that are under-designed for their importance.",
    "- **Integration and generalization**: opportunities to make the project more portable, composable, or protocol-aligned (e.g., MCP, standard APIs, plugin architectures).",
    "- **Missing capabilities**: gaps in the design that would become pain points as the project evolves.",
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
