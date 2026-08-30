import {
  DISPATCH_PROMPT_HANDOFF_NOTE,
  buildFrictionTriageBlock,
  type FrictionTriageDecision,
} from "audit-tools/shared";
import type { AnalyzerPlanEntry } from "../extractors/analyzers/types.js";
import { renderCommand } from "./args.js";

function cliInvocationTokens(): string[] {
  const raw = process.env.AUDIT_CODE_INVOCATION;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (token) => typeof token === "string" && token.length > 0,
        )
      ) {
        return parsed;
      }
    } catch {
      // Malformed overrides fall back to the installed bin.
    }
  }
  return ["audit-code"];
}

export function renderAnalyzerConsentPrompt(params: {
  pending: Array<{
    id: string;
    runner: string;
    spec: string;
    purpose?: string;
    safetyProfile: {
      config_execution: string;
      network_egress: boolean;
      version_pinning: string;
    };
  }>;
  decisionsPath: string;
  continueCommand: string;
}): string {
  const rows = params.pending
    .map((candidate) => {
      const why: string[] = [];
      if (candidate.safetyProfile.config_execution === "executable") {
        why.push("its config can execute repo code");
      }
      if (candidate.safetyProfile.network_egress) {
        why.push("it makes network requests");
      }
      if (candidate.safetyProfile.version_pinning !== "pinned") {
        why.push(
          `its version is ${candidate.safetyProfile.version_pinning}`,
        );
      }
      return [
        `### \`${candidate.id}\` (${candidate.runner}: \`${candidate.spec}\`)`,
        "",
        `- Detects: ${candidate.purpose ?? "(no purpose recorded)"}`,
        `- Consent-gated because ${why.join("; ") || "it is heavier than the default set"}.`,
      ].join("\n");
    })
    .join("\n\n");
  const example = JSON.stringify(
    Object.fromEntries(
      params.pending.map((candidate, index) => [
        candidate.id,
        index === 0 ? "granted" : "declined",
      ]),
    ),
    null,
    2,
  );
  return `# External Analyzer Consent

This repo is applicable to ${params.pending.length} consent-gated analyzer(s) with no recorded
decision. Present EACH candidate below to the operator and record their choices —
\`declined\` persists across runs; \`granted\` covers this run only, and the next run re-offers.
Do not decide on the operator's behalf.

${rows}

## Record the decisions

Write ONE JSON object covering every candidate above to:

\`${params.decisionsPath}\`

For example:

\`\`\`json
${example}
\`\`\`

Then continue:

\`${params.continueCommand}\`
`;
}

export function nextStepCommand(root: string, artifactsDir: string): string {
  return renderCommand([
    ...cliInvocationTokens(),
    "next-step",
    "--root",
    root,
    "--artifacts-dir",
    artifactsDir,
  ]);
}

export function renderEdgeReasoningDispatchPrompt(params: {
  promptPath: string;
  resultsPath: string;
  continueCommand: string;
  contentHash: string;
  candidateCount: number;
}): string {
  return [
    "# audit-code edge reasoning (host workload)",
    "",
    `The dependency graph has ${params.candidateCount} low-confidence edge(s) whose`,
    "machine-generated `reason` text can be clarified. This is one bounded host task:",
    "it only rewrites edge reasons and never changes topology or weights.",
    "",
    DISPATCH_PROMPT_HANDOFF_NOTE,
    "",
    `Prompt path: ${params.promptPath}`,
    `Result path: ${params.resultsPath}`,
    `Cache key: ${params.contentHash}`,
    "",
    "Execute the prompt with the host facilities available in this conversation and write",
    "the exact JSON result to the result path. If a cached result has the same key, it may",
    "be reused. The host owns every execution choice.",
    "",
    `Then run: ${params.continueCommand}`,
    "",
  ].join("\n");
}

export function renderPresentReportPrompt(
  finalReportPath: string,
  triage?: FrictionTriageDecision,
): string {
  const frictionBlock = triage ? buildFrictionTriageBlock(triage) : "";
  if (triage?.action === "dispose") {
    return [
      "# audit-code friction triage",
      "",
      "Complete friction triage before the audit report is presented.",
      frictionBlock,
    ].join("\n");
  }
  return [
    "# audit-code present report",
    "",
    "The deterministic audit is complete.",
    "",
    `Read the final audit report from: ${finalReportPath}`,
    "",
    "Present the completed audit with work blocks first.",
    frictionBlock,
    "Do not run the orchestrator again for this completed audit.",
    "",
  ].join("\n");
}

export function renderAnalyzerInstallPrompt(params: {
  unresolved: AnalyzerPlanEntry[];
  decisionsPath: string;
  continueCommand: string;
}): string {
  const analyzerLines = params.unresolved.map(
    (entry) =>
      `- **${entry.id}** — needs \`${entry.dependency ?? entry.id}\`; ${entry.supportedCount} in-scope file(s) would be analyzed.`,
  );
  const exampleObject = `{ ${params.unresolved
    .map((entry) => `"${entry.id}": "ephemeral"`)
    .join(", ")} }`;
  return [
    "# audit-code analyzer install",
    "",
    "Optional language analyzers can enrich the deterministic graph.",
    "",
    ...analyzerLines,
    "",
    "Choose `ephemeral`, `permanent`, or `skip` for each analyzer and write the",
    "JSON object below. These choices persist in the provider-neutral analyzer policy.",
    "",
    `Decisions path: ${params.decisionsPath}`,
    `Example: ${exampleObject}`,
    "",
    `Then run: ${params.continueCommand}`,
    "",
  ].join("\n");
}
