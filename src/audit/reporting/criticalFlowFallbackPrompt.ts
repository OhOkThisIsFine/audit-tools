import type { CriticalFlowManifest } from "audit-tools/shared";

const MAX_RENDERED_FLOWS = 80;

function summarizeFlow(
  flow: CriticalFlowManifest["flows"][number],
): string {
  const entrypoints = flow.entrypoints.slice(0, 4).join(", ");
  const paths = flow.paths.slice(0, 6).join(", ");
  const concerns = flow.concerns.join(", ");
  return (
    `- \`${flow.id}\` [confidence: ${flow.confidence ?? "unset"}] ${flow.name}\n` +
    `  entrypoints: ${entrypoints || "(none)"}\n` +
    `  paths: ${paths || "(none)"}\n` +
    `  concerns: ${concerns || "(none)"}`
  );
}

/**
 * Prompt for the critical-flow LLM fallback pass. The deterministic flow
 * inference marked itself below the confidence bar (no flows found, or some are
 * low-confidence), so the host reviews the repository's ACTUAL critical user /
 * system flows and returns an additive enrichment. It does not re-audit code or
 * invent findings — it authors the flow map the deterministic heuristics missed.
 */
export function renderCriticalFlowFallbackPrompt(
  manifest: CriticalFlowManifest,
): string {
  const flows = manifest.flows;
  const rendered = flows.slice(0, MAX_RENDERED_FLOWS).map(summarizeFlow);
  const overflowNote =
    flows.length > MAX_RENDERED_FLOWS
      ? [
          `  ... and ${flows.length - MAX_RENDERED_FLOWS} more flows (see critical_flows.json).`,
        ]
      : [];

  const lowConfidenceIds = flows
    .filter((flow) => flow.confidence === "low")
    .map((flow) => flow.id);

  return [
    "# Critical-flow fallback",
    "",
    "Deterministic critical-flow inference fell below its confidence bar" +
      (flows.length === 0
        ? " — it found NO critical flows for this repository."
        : lowConfidenceIds.length > 0
          ? ` — ${lowConfidenceIds.length} inferred flow(s) are low-confidence.`
          : "."),
    "",
    "A critical flow is an end-to-end user or system path whose failure has outsized",
    "blast radius — authentication/session, billing/payment, data-write/migration,",
    "async/queue processing, deploy/infra, or any repo-specific mission-critical path.",
    "",
    "Review the repository and return an ADDITIVE enrichment of the flow map:",
    "- ADD any genuine critical flow the deterministic pass missed (use a fresh id",
    "  like `flow:host:<short-slug>`).",
    "- UPGRADE a listed low-confidence flow by re-authoring it with its EXACT id",
    "  above and `confidence: \"high\"`, correcting its entrypoints/paths/concerns.",
    "- Cite only real repository paths. Do not invent files.",
    "- Omit a flow you cannot substantiate; return an empty array if the repo has no",
    "  critical flows the deterministic pass missed.",
    "",
    "## Deterministic flows",
    "",
    ...(rendered.length > 0
      ? rendered
      : ["- (deterministic inference recorded no flows)"]),
    ...overflowNote,
    "",
    "## Output format",
    "",
    "Write a single JSON object conforming to:",
    "",
    "```json",
    "{",
    '  "flows": [',
    "    {",
    '      "id": "flow:host:checkout",',
    '      "name": "short flow name",',
    '      "entrypoints": ["src/api/checkout.ts"],',
    '      "paths": ["src/api/checkout.ts", "src/billing/charge.ts"],',
    '      "concerns": ["data_integrity", "security"],',
    '      "confidence": "high"',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "`concerns` are free-form lens tags (e.g. security, data_integrity, reliability,",
    "correctness). Every `paths` entry must be a real, in-scope repository file.",
    "",
  ].join("\n");
}
