import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
// sites-pinned: tests/audit/functional-preflight.test.ts
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AGENT_FEEDBACK_FILENAME, AgentReflectionSchema,
  readOptionalJsonFile, readOptionalTextFile, writeTextFile, isJsonParseError, toPromptPathToken,
} from "audit-tools/shared";
import { readRunConsentUnlocked } from "../../shared/analyzerRunConsent.js";
import type { writeCurrentStep } from "./steps.js";
import { renderCommand } from "./args.js";

const EvidenceSchema = z.object({ available: z.boolean(), evidence: z.string().trim().min(1) }).strict();
export const FunctionalPreflightSchema = z.object({
  contract_version: z.literal("audit-functional-preflight/v1"),
  run_id: z.string().uuid(),
  repository_root: z.string(),
  source_inspection: EvidenceSchema,
  relationship_inspection: EvidenceSchema,
  decision: z.enum(["ready", "degraded", "stop"]),
  operator_approved_degraded: z.boolean().default(false),
  limitation: z.string().trim().optional(),
}).strict().superRefine((report, context) => {
  if (report.decision === "ready" && (!report.source_inspection.available || !report.relationship_inspection.available)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Ready requires working source and relationship inspection." });
  }
  if (report.decision === "degraded" && (!report.source_inspection.available || !report.operator_approved_degraded || !report.limitation)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A degraded audit requires source inspection, explicit operator approval, and a concrete limitation." });
  }
});

export const functionalPreflightPath = (artifactsDir: string): string => join(artifactsDir, "functional-preflight.json");

/** One run-bound functional declaration; never a provider or installed-tool inventory. */
export async function functionalPreflightStep(
  root: string, artifactsDir: string,
): Promise<Parameters<typeof writeCurrentStep>[0] | undefined> {
  return withArtifactTreeHold(artifactsDir, undefined, async () => {
    // The host echoes the root it was shown, and writeStepContract forward-slashes every
    // win32 path in the prompt body: emit and bind the prompt-path token form, or a raw
    // backslashed root reaches the host rewritten and the report never matches this run.
    const canonicalRoot = toPromptPathToken(await realpath(root));
    const run = await readRunConsentUnlocked(root, artifactsDir);
    const reportPath = functionalPreflightPath(artifactsDir);
    let problem = "No functional capability evidence has been recorded for this audit.";
    let stopped = false;
    try {
      const raw = await readOptionalJsonFile<unknown>(reportPath);
      if (raw !== undefined) {
        const parsed = FunctionalPreflightSchema.safeParse(raw);
        if (!parsed.success) problem = `Correct the preflight report: ${parsed.error.issues.map(issue => issue.message).join("; ")}`;
        else if (parsed.data.run_id !== run.run_id || toPromptPathToken(parsed.data.repository_root) !== canonicalRoot) {
          problem = "The preflight report belongs to another run or repository. Check this run again.";
        } else if (parsed.data.decision === "stop") {
          problem = "The operator stopped this audit because required capabilities are unavailable. Do not continue without a new operator decision.";
          stopped = true;
        } else {
          if (parsed.data.decision === "degraded") {
            const reflection = AgentReflectionSchema.parse({
              task_id: "audit-capability-preflight", instruction_clarity: "clear", severity: "high",
              tool_friction: [parsed.data.limitation],
              ambiguities: ["The operator approved a degraded, non-comprehensive audit."],
            });
            const feedbackPath = join(artifactsDir, AGENT_FEEDBACK_FILENAME);
            const prior = await readOptionalTextFile(feedbackPath) ?? "";
            const line = JSON.stringify(reflection);
            // Preserve every other line, including malformed feedback; never silently repair another writer's data.
            if (!prior.split(/\r?\n/).includes(line)) await writeTextFile(feedbackPath, prior + (prior && !prior.endsWith("\n") ? "\n" : "") + line + "\n");
          }
          return undefined;
        }
      }
    } catch (error) {
      if (!isJsonParseError(error)) throw error;
      problem = "The functional preflight report is not valid JSON. Rewrite it using the shape below.";
    }
    const next = renderCommand(["audit-code", "next-step", "--root", root, "--artifacts-dir", artifactsDir]);
    const example = {
      contract_version: "audit-functional-preflight/v1", run_id: run.run_id, repository_root: canonicalRoot,
      source_inspection: { available: false, evidence: "Describe a source inspection actually performed, or the concrete failure." },
      relationship_inspection: { available: false, evidence: "Describe a dependency/call/structural relationship actually inspected, or the concrete failure." },
      decision: "stop", operator_approved_degraded: false, limitation: "State missing coverage, if any.",
    };
    return {
      artifactsDir, repoRoot: root, runId: run.run_id, stepKind: "functional_preflight",
      status: stopped ? "blocked" : "ready", allowedCommands: [next],
      artifactPaths: { functional_preflight: reportPath },
      access: { read_paths: [root], write_paths: [reportPath] },
      progress: { summary: problem },
      stopCondition: "Record observed functional evidence. Continue only when ready or after explicit operator approval of the degraded scope; a stop decision remains stopped.",
      prompt: [
        "# Check the host's audit capabilities", "", problem, "",
        "Actor: the host coordinating this audit. Use currently available read-only tools to inspect source and a real structural relationship in this repository. An installed tool name is not evidence. Do not install tools or change settings for this check.",
        "Record what you actually inspected and the observed result for both capabilities. Do not report provider names, model inventories or routing settings.",
        "If both capabilities work, choose ready. If relationship inspection is unavailable, explain the limitation and ask the operator to choose a degraded quick/shallow audit or stop. Degraded requires explicit approval; source inspection is always required. Do not perform semantic audit work while stopped.",
        `Write the complete JSON report to ${reportPath}:`, "```json", JSON.stringify(example, null, 2), "```", "",
        `After a ready or approved degraded report, run ${next}. If the decision is stop, stop and preserve the work until the operator changes it.`,
      ].join("\n"),
    };
  });
}

/** Direct semantic CLI actions cannot skip the same entry requirement. */
export async function requireFunctionalPreflight(root: string, artifactsDir: string): Promise<void> {
  const pending = await functionalPreflightStep(root, artifactsDir);
  if (pending) throw new Error(`${pending.progress?.summary} Run audit-code next-step to complete functional preflight first.`);
}
