// sites-pinned: tests/shared/prompt-renders-its-contract.test.ts
import {
  DISPATCH_PROMPT_HANDOFF_NOTE,
  buildFrictionTriageBlock,
  renderHostScratchNote,
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
      const risks: string[] = [];
      if (candidate.safetyProfile.config_execution === "executable") {
        risks.push("Arbitrary code execution during config evaluation");
      }
      if (candidate.safetyProfile.network_egress) {
        risks.push("Outbound network requests");
      }
      if (candidate.safetyProfile.version_pinning !== "pinned") {
        risks.push(
          `Unpinned version (${candidate.safetyProfile.version_pinning})`,
        );
      }
      return [
        `### \`${candidate.id}\` (${candidate.runner}: \`${candidate.spec}\`)`,
        "",
        `- Detects: ${candidate.purpose ?? "(no purpose recorded)"}`,
        `- Security & execution risks: ${risks.join("; ") || "heavier resource profile than the default set"}.`,
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

This repo is applicable to ${params.pending.length} consent-gated analyzer(s) with no decision
recorded for this run. All decisions are strictly per-run and do not persist across runs —
the next run asks again, whatever is decided here.

Ask the operator directly using your host's question/confirmation mechanism. For EACH
candidate below, ask whether to fetch/install and run \`<spec>\` via \`<runner>\` in this
run. Do not make assumptions or answer on the operator's behalf.

A \`granted\` answer authorizes an observe-only run: consent-gated analyzers never modify
source files. The audit's only source-mutating phase (the opt-in auto-fix formatters) is
a separate per-run decision, never implied by this one.

${rows}

## Record the decisions

Write ONE JSON object mapping every candidate ID above to either \`"granted"\` or \`"declined"\` (no other value is accepted) to:

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
  /**
   * Run-scoped scratch directory (`hostScratchDir`) this lane's executor must
   * improvise any working files under. REQUIRED, not optional: the pair had no
   * caller at all until this note was wired, and an optional parameter would
   * let the next emission site silently reintroduce the same gap. Scratch left
   * at the audited repo's root is untracked litter that the NEXT audit's
   * manifest walk picks up — the exact hazard the disposition's untracked rule
   * exists to contain.
   */
  scratchDirPath: string;
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
    renderHostScratchNote(params.scratchDirPath),
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
    "Ask the operator using your host's question mechanism to choose an install",
    "option for each analyzer. Do not make package installation decisions",
    "without operator confirmation.",
    "",
    "Allowed values: `\"ephemeral\"` | `\"permanent\"` | `\"skip\"`. These choices persist",
    "in the provider-neutral analyzer policy.",
    "",
    "## Record the decisions",
    "",
    "Write ONE JSON object mapping every analyzer ID above to your choice:",
    "",
    `Decisions path: ${params.decisionsPath}`,
    "",
    "```json",
    `${exampleObject}`,
    "```",
    "",
    `Then run: ${params.continueCommand}`,
    "",
  ].join("\n");
}
