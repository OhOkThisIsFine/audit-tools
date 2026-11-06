// sites-pinned: tests/audit/next-step-critical-flow-fallback.test.ts
import type { CriticalFlowManifest } from "audit-tools/shared";

type CriticalFlow = CriticalFlowManifest["flows"][number];

/**
 * A low-confidence flow is the lane's work, so it is rendered IN FULL: every
 * entrypoint, every candidate path (the keyword heuristic's guesses are the
 * related-file hint the executor would otherwise have to grep for), every concern.
 */
function renderLowConfidenceFlow(flow: CriticalFlow): string {
  return (
    `- \`${flow.id}\` — ${flow.name}\n` +
    `  entrypoints: ${flow.entrypoints.join(", ") || "(none)"}\n` +
    `  candidate paths (keyword guesses, not graph-confirmed): ${flow.paths.join(", ") || "(none)"}\n` +
    `  concerns: ${flow.concerns.join(", ") || "(none)"}`
  );
}

/** A graph-corroborated flow is context only: its id and name, one line each. */
function renderCorroboratedFlow(flow: CriticalFlow): string {
  return `- \`${flow.id}\` — ${flow.name}`;
}

/**
 * Prompt for the critical-flow LLM fallback pass. The deterministic flow
 * inference marked itself below the confidence bar (no flows found, or some are
 * low-confidence), so the host reviews the repository's ACTUAL critical user /
 * system flows and returns an additive enrichment. It does not re-audit code or
 * invent findings — it authors the flow map the deterministic heuristics missed.
 *
 * Only the low-confidence flows are the lane's work, so only they are rendered
 * in full; every other flow is listed by id so the lane can see what already
 * exists without re-reading it. Every flow is listed — the prompt is complete on
 * its own, and `manifestPath` (an audit artifact, NOT a source file) is named
 * only as the record the lane may consult.
 */
export function renderCriticalFlowFallbackPrompt(
  manifest: CriticalFlowManifest,
  manifestPath?: string,
): string {
  const flows = manifest.flows;
  const low = flows.filter((flow) => flow.confidence === "low");
  const corroborated = flows.filter((flow) => flow.confidence !== "low");

  return [
    "# Critical-flow fallback",
    "",
    "Deterministic critical-flow inference fell below its confidence bar" +
      (flows.length === 0
        ? " — it found NO critical flows for this repository."
        : low.length > 0
          ? ` — ${low.length} of ${flows.length} inferred flow(s) are low-confidence.`
          : "."),
    "",
    "A critical flow is an end-to-end user or system path whose failure has outsized",
    "blast radius — authentication/session, billing/payment, data-write/migration,",
    "async/queue processing, deploy/infra, or any repo-specific mission-critical path.",
    "",
    "Review the repository and return an ADDITIVE enrichment of the flow map:",
    "- UPGRADE each low-confidence flow listed below that is a real critical flow:",
    "  re-author it with its EXACT id and `confidence: \"high\"`, and correct its",
    "  entrypoints/paths/concerns. Its candidate paths are keyword guesses: keep only",
    "  the files the flow actually runs through.",
    "- Omit a low-confidence flow that is not a real critical flow (for example a",
    "  template or config file that nothing executes as a path). Omitting it is a",
    "  valid answer; it stays in the map at low confidence.",
    "- ADD any genuine critical flow the deterministic pass missed, with a fresh id",
    "  like `flow:host:<short-slug>`.",
    "- Do not resubmit any other listed flow unless you correct it; a correction",
    "  uses its exact id.",
    "- Cite only real repository paths. Do not invent files. Return an empty `flows`",
    "  array when there is nothing to upgrade or add.",
    "",
    ...(manifestPath
      ? [
          `The complete flow records are in the audit artifact \`${manifestPath}\`. This file`,
          "is an audit artifact, not repository source: read it there, not in the source tree.",
          "Everything this task needs is listed below.",
          "",
        ]
      : []),
    "## Low-confidence flows (your work)",
    "",
    ...(low.length > 0
      ? low.map(renderLowConfidenceFlow)
      : ["- (none — look only for missed flows)"]),
    "",
    "## Other flows (context; not low confidence)",
    "",
    ...(corroborated.length > 0
      ? corroborated.map(renderCorroboratedFlow)
      : ["- (deterministic inference recorded no other flows)"]),
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
