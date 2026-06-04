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

function summarizeFlows(bundle: ArtifactBundle): string {
  const flows = bundle.critical_flows?.flows ?? [];
  if (flows.length === 0) return "No critical flows identified.";

  const lines = flows.map(
    (flow) =>
      `- ${flow.name}: ${flow.paths.length} files, concerns: ${flow.concerns.join(", ") || "none"}`,
  );

  return [`${flows.length} critical flows:`, ...lines].join("\n");
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

function summarizeSurfaces(bundle: ArtifactBundle): string {
  const surfaces = bundle.surface_manifest?.surfaces ?? [];
  if (surfaces.length === 0) return "No externally reachable surfaces identified.";

  const lines = surfaces.map(
    (surface) =>
      `- ${surface.id} (${surface.kind}): ${surface.entrypoint}${surface.methods?.length ? ` [${surface.methods.join(", ")}]` : ""}`,
  );

  return [`${surfaces.length} surfaces:`, ...lines].join("\n");
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

function formatDeterministicFindings(findings: Finding[]): string {
  if (findings.length === 0)
    return "No structural issues detected by deterministic analysis.";

  const lines = findings.map(
    (finding) =>
      `- [${finding.severity}] ${finding.title}: ${finding.summary}`,
  );

  return [
    `${findings.length} structural findings from deterministic analysis:`,
    ...lines,
  ].join("\n");
}

export interface DesignReviewOptions {
  max_units?: number;
}

export function renderDesignReviewPrompt(
  bundle: ArtifactBundle,
  options: DesignReviewOptions = {},
): string {
  const deterministicFindings = bundle.design_assessment?.findings ?? [];

  const unitCount = bundle.unit_manifest?.units.length ?? 0;
  const defaultMaxUnits = Math.max(5, Math.min(20, Math.ceil(unitCount / 5)));
  const maxUnits = options.max_units ?? defaultMaxUnits;
  const prioritizedReadingList = buildPrioritizedReadingList(bundle, maxUnits);

  return [
    "# Project design review",
    "",
    "You are reviewing the overall design of this project. The deterministic audit pipeline has already analyzed the codebase structure. Your job is to provide qualitative, big-picture design observations that static analysis cannot produce.",
    "",
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
    "## What to assess",
    "",
    `Focus on the ${maxUnits} highest-risk units listed below; you need not read the entire repository, though you may follow any thread that demands more context. Produce findings about:`,
    "",
    "### Prioritised reading list",
    "",
    prioritizedReadingList,
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
    "Write the JSON array to the design review results path provided below. Use finding IDs starting with DR-001.",
    "",
    "Focus on substantive, actionable observations. Prefer fewer high-quality findings over many surface-level ones.",
    "",
  ].join("\n");
}
