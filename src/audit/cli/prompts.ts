// sites-pinned: tests/audit/analyzer-consent-offer.test.ts, tests/shared/review-independence.test.ts, tests/shared/prompts.test.ts
import {
  DISPATCH_PROMPT_HANDOFF_NOTE,
  ANALYZER_SETTINGS,
  renderHostScratchNote,
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
Both \`declined\` and \`granted\` cover this run only; a new audit asks again.
Ask explicitly before installing these analyzers or permitting their code/config execution.
Audits do not format source by default. Source formatting requires separate operator approval
and \`next-step --auto-fix\` for this run; \`--dry-run\` always prevents formatting.
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

export function renderPresentReportPrompt(finalReportPath: string): string {
  return [
    "# audit-code present report",
    "",
    "The deterministic audit is complete.",
    "",
    `Read the final audit report from: ${finalReportPath}`,
    "",
    "Present the completed audit with work blocks first.",
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
    `Ask the operator to choose one of ${ANALYZER_SETTINGS.map(value => "`" + value + "`").join(", ")} for each analyzer, then write the JSON object below.`,
    "Use repo to reuse an existing installation without installing. Ephemeral and permanent currently both install into the tool-managed cache, not the repository dependencies. Use skip to omit the analyzer, or auto to retry automatic resolution; if it remains unavailable, this decision step returns.",
    "These choices persist in the provider-neutral analyzer policy; only the operator authorizes an installation.",
    "",
    `Decisions path: ${params.decisionsPath}`,
    `Example: ${exampleObject}`,
    "",
    `Then run: ${params.continueCommand}`,
    "",
  ].join("\n");
}
