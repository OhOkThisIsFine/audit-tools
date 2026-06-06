import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import { ItemSpec, ClosingPlan, ClarificationRequest, Finding } from "../state/types.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  readOptionalJsonFile,
  writeJsonFile,
  readJsonFile,
  formatValidationIssues,
  detectRepoConventions,
  formatRepoConventions,
  type SessionConfig,
} from "@audit-tools/shared";
import { validateDocumentResponse } from "../validation/remediationState.js";
import {
  createLaunchInputForTask,
  createRemediationWorkerTask,
} from "./workerTasks.js";

interface DocumentResponse {
  type: "item_spec" | "clarification_request";
  item_spec?: ItemSpec;
  clarifications?: ClarificationRequest[];
}

interface ClarificationResolution {
  finding_id: string;
  action: "clarified" | "deemed_inappropriate";
  rationale?: string;
}

function markStarted(item: { started_at?: string; completed_at?: string }): void {
  item.started_at ??= new Date().toISOString();
  delete item.completed_at;
}

function markTerminal(item: { started_at?: string; completed_at?: string }): void {
  const now = new Date().toISOString();
  item.started_at ??= now;
  item.completed_at = now;
}

/**
 * Render the per-finding documentation worker prompt. Pulled out of
 * `runDocumentPhase` so the prompt's logic (which finding fields to surface),
 * its fixed format contract (the item_spec / clarification_request JSON shape
 * and the allowed clarification categories), and its per-call data (paths,
 * theme hint, conventions) are assembled in one named place rather than inline
 * inside the document loop.
 */
function buildDocumentPrompt(params: {
  finding: Finding;
  extraContext: string;
  themeHint: string;
  repoConventions: string;
  taskPath: string;
  resultPath: string;
}): string {
  const { finding, extraContext, themeHint, repoConventions, taskPath, resultPath } =
    params;
  return `
You are the Remediation Assistant. Your task is to analyze the following finding and produce an item_spec.json detailing how you will fix it.

Finding ID: ${finding.id}
Title: ${finding.title}
Summary: ${finding.summary}
Affected Files: ${finding.affected_files.map((f) => f.path).join(", ")}
Evidence:
${(finding.evidence ?? []).map((e) => `- ${e}`).join("\n")}
${extraContext}${themeHint}${repoConventions ? `\n${repoConventions}\n` : ""}
If the finding is clear (or clarified by the context above), output a JSON object with type "item_spec" and the item_spec.
The item_spec MUST include a "touched_files" array of every repo-relative path your fix will create or modify. If the real fix belongs in files other than the Affected Files above, put the correct paths there — the implementer is granted write access to exactly these files.
If the finding is ambiguous, output a JSON object with type "clarification_request" and an array of clarifications.
When requesting clarifications, you MUST use one of the following exact categories:
"public_contract", "behavioral_semantics", "scope_of_fix", "dependency_introduction", "compatibility_policy", "intent_vs_symptom", "issue_appropriateness".

Output format must be exactly:
{
  "type": "item_spec" | "clarification_request",
  "item_spec": { ... schema ... },
  "clarifications": [ { "finding_id": "...", "category": "...", "description": "..." } ]
}

Your task JSON is at: ${taskPath}
Write your result JSON to exactly this path: ${resultPath}
Use the Write tool to create or overwrite that file.
Do not write to any other path.
    `.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeClarificationResolutions(
  value: unknown,
): ClarificationResolution[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).flatMap((entry) => {
      if (
        typeof entry.finding_id === "string" &&
        (entry.action === "clarified" ||
          entry.action === "deemed_inappropriate")
      ) {
        return [
          {
            finding_id: entry.finding_id,
            action: entry.action,
            rationale:
              typeof entry.rationale === "string"
                ? entry.rationale
                : undefined,
          },
        ];
      }
      return [];
    });
  }

  if (!isRecord(value)) return [];

  if (Array.isArray(value.resolutions)) {
    return normalizeClarificationResolutions(value.resolutions);
  }
  if (Array.isArray(value.items)) {
    return normalizeClarificationResolutions(value.items);
  }

  return Object.entries(value).flatMap(([findingId, entry]) => {
    if (!isRecord(entry)) return [];
    if (
      entry.action !== "clarified" &&
      entry.action !== "deemed_inappropriate"
    ) {
      return [];
    }
    return [
      {
        finding_id:
          typeof entry.finding_id === "string" ? entry.finding_id : findingId,
        action: entry.action,
        rationale:
          typeof entry.rationale === "string" ? entry.rationale : undefined,
      },
    ];
  });
}

export async function runDocumentPhase(
  state: RemediationState,
  options: OrchestratorOptions,
): Promise<RemediationState> {
  console.log("Running Document Phase...");

  if (!state.plan || !state.items) {
    throw new Error(
      "Cannot run document phase: plan or items missing from state.",
    );
  }

  const sessionConfig =
    (await readOptionalJsonFile<SessionConfig>(
      join(options.root, "session-config.json"),
    )) || {};
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const workerTimeoutMs = sessionConfig.timeout_ms;

  const clarifications: ClarificationRequest[] = [];

  const resolutionsMap = new Map<string, ClarificationResolution>();
  const resolutionPath = join(
    options.artifactsDir,
    "clarification_resolution.json",
  );
  if (existsSync(resolutionPath)) {
    const resolutions = await readOptionalJsonFile<unknown>(resolutionPath);
    const normalizedResolutions =
      normalizeClarificationResolutions(resolutions);
    if (normalizedResolutions.length === 0) {
      console.warn(
        `Ignoring ${resolutionPath}: expected an array, { resolutions: [...] }, { items: [...] }, or finding-id keyed object.`,
      );
    }
    for (const res of normalizedResolutions) {
      if (
        res.action === "deemed_inappropriate" &&
        state.items[res.finding_id]
      ) {
        state.items[res.finding_id].status = "deemed_inappropriate";
        markTerminal(state.items[res.finding_id]);
        state.items[res.finding_id].failure_reason = res.rationale;
      } else if (res.action === "clarified" && state.items[res.finding_id]) {
        resolutionsMap.set(res.finding_id, res);
      }
    }
  }

  // Detected once per run: house style the worker should match (Phase 7A).
  const repoConventions = formatRepoConventions(
    detectRepoConventions(options.root),
  );

  for (const finding of state.plan.findings) {
    const item = state.items[finding.id];
    if (
      !item ||
      item.status === "documented" ||
      item.status === "deemed_inappropriate" ||
      item.status === "ignored" ||
      item.status === "resolved" ||
      item.status === "resolved_no_change"
    ) {
      continue;
    }

    console.log(`Documenting finding ${finding.id}...`);

    // Phase 7A: reuse the auditor's synthesis theme (no new LLM pass) to hand the
    // worker the shared root-cause fix pattern when this finding carries one.
    const theme = finding.theme_id
      ? state.plan.themes?.find((t) => t.theme_id === finding.theme_id)
      : undefined;
    const themeHint = theme
      ? `\nSYNTHESIS THEME (${theme.theme_id} — ${theme.title}):\nRoot cause: ${theme.root_cause}\nSuggested fix pattern: ${theme.suggested_fix_pattern}\nApply this shared pattern where it fits this finding.\n`
      : "";

    const existingClarification = resolutionsMap.get(finding.id);
    const extraContext = existingClarification
      ? `\nPREVIOUS CLARIFICATION CONTEXT:\nUser provided the following resolution to your previous ambiguity: ${existingClarification.rationale}\nPlease use this information to finalize the item_spec.\n`
      : "";

    const taskPath = join(options.artifactsDir, `task_${finding.id}.json`);
    const resultPath = join(
      options.artifactsDir,
      `document_result_${finding.id}.json`,
    );
    const stdoutPath = join(options.artifactsDir, `stdout_${finding.id}.txt`);
    const stderrPath = join(options.artifactsDir, `stderr_${finding.id}.txt`);

    const promptPath = join(options.artifactsDir, `prompt_${finding.id}.md`);
    const promptContent = buildDocumentPrompt({
      finding,
      extraContext,
      themeHint,
      repoConventions,
      taskPath,
      resultPath,
    });
    await writeFile(promptPath, promptContent, "utf8");

    const task = createRemediationWorkerTask({
      runId: state.plan.plan_id,
      options,
      obligationId: finding.id,
      preferredExecutor: provider.name,
      resultPath,
      timeoutMs: workerTimeoutMs,
    });
    await writeJsonFile(taskPath, task);

    await provider.launch(createLaunchInputForTask(options, task, {
      promptPath,
      taskPath,
      stdoutPath,
      stderrPath,
    }));

    try {
      const docResult = await readJsonFile<DocumentResponse>(resultPath);
      const docIssues = validateDocumentResponse(docResult);
      if (docIssues.length > 0) {
        const errors = docIssues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          throw new Error(
            `Invalid document response for ${finding.id}:\n${formatValidationIssues(errors)}`,
          );
        }
      }
      if (
        docResult.type === "clarification_request" &&
        docResult.clarifications
      ) {
        clarifications.push(...docResult.clarifications);
        for (const clar of docResult.clarifications) {
          if (clar.category === "public_contract") {
            const block = state.plan.blocks.find((b) =>
              b.items.includes(finding.id),
            );
            if (block && block.parallel_safe) {
              console.log(
                `Stripping parallel_safe from block ${block.block_id} due to public_contract dependency inference.`,
              );
              block.parallel_safe = false;
            }
          }
        }
      } else if (docResult.type === "item_spec" && docResult.item_spec) {
        item.item_spec = docResult.item_spec;
        item.status = "documented";
        markStarted(item);
        await writeJsonFile(
          join(options.artifactsDir, `item_spec_${finding.id}.json`),
          docResult.item_spec,
        );
      } else {
        throw new Error("Invalid response type from LLM");
      }
    } catch (e) {
      console.error(
        `Failed to read document result for ${finding.id} (provider: ${provider.name}, resultPath: ${resultPath}, taskPath: ${taskPath}):`,
        e,
      );
      item.status = "blocked";
      markTerminal(item);
      item.failure_reason =
        "LLM failed to generate a valid item specification or clarification.";
    }
  }

  // Items still in "pending" after the document loop were never processed (e.g.
  // the plan added a finding that has no item in state.items). Block them so
  // they surface in triage instead of being silently skipped by executeBlock.
  for (const item of Object.values(state.items)) {
    if (item.status === "pending") {
      item.status = "blocked";
      markTerminal(item);
      item.failure_reason = "Item was not processed during the document phase.";
    }
  }

  if (clarifications.length > 0) {
    await writeJsonFile(
      join(options.artifactsDir, "clarification_request.json"),
      clarifications,
    );
    console.log(
      `Found ${clarifications.length} ambiguities. Halting for user clarification.`,
    );
    return { ...state, status: "waiting_for_clarification", clarifications };
  }

  if (!state.closing_plan) {
    state.closing_plan = { action: "none" };
    await writeJsonFile(join(options.artifactsDir, "closing_plan.json"), state.closing_plan);
  }

  return { ...state, status: "documenting", clarifications: [] };
}
