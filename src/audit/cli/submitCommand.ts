// sites-pinned: tests/audit/result-submit.test.ts
import { outputJson } from "./cliHelpers.js";
import { nextStepCommand } from "./prompts.js";
import { submitGateResult, SUPPORTED_GATE_SUBMISSIONS } from "./submitGateResult.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";
import { consolidateAuditQuestionFindings, readAuditQuestionLedger, readAuditQuestionWorkload, reopenAuditQuestions, submitAuditQuestionResult } from "./dispatch/hostHandoff.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { computeStaleArtifacts } from "../orchestrator/staleness.js";
import { readRunSourceRoot } from "../io/runSnapshot.js";
import { assertQualifiedReviewStillCurrent, deriveCurrentQuestionBindings, deriveQuestionCycleUnlocked } from "./questionReviewCycle.js";
import { ReviewReopenRequestSchema, type ReviewToolingTransition } from "../../shared/types/reviewQuestion.js";
import { ReviewFindingConsolidationSchema } from "../../shared/types/questionReviewReport.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";
import { stableStringify } from "../../shared/stableStringify.js";
import { toPosixPath } from "../../shared/paths.js";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";

async function verifyCurrentQuestionInputs(root: string, artifactsDir: string, requestedTooling?: ReviewToolingTransition) {
  const bundle = await loadArtifactBundle(artifactsDir, { requestedTooling });
  if (bundle.audit_state?.status === "complete") throw new Error("The finished report cannot be changed.");
  if (!bundle.repo_manifest || !bundle.review_plan || computeStaleArtifacts(bundle, { emit: false }).has("review_plan.json")) {
    throw new Error("The review plan is missing or stale; run next-step to refresh it.");
  }
  const sourceRoot = await readRunSourceRoot(root, artifactsDir);
  if (bundle.review_tooling_qualification) {
    await assertQualifiedReviewStillCurrent(bundle, sourceRoot);
  } else {
    const scope = reviewSourceScope(bundle, bundle.scope);
    const admitted = [...new Set([...scope.allowedSourcePaths, ...scope.allowedContractPaths])];
    if (!(await checkFileIntegrity(sourceRoot, bundle.repo_manifest, admitted)).is_clean) {
      throw new Error("The frozen source changed; run next-step before submitting.");
    }
  }
  return { bundle, sourceRoot };
}


/**
 * Both entrypoints accept through the current question assignment's ledger.
 * Legacy file-review artifacts are archives, not a fallback submission route.
 */
export async function submitWorkItemResult(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly workItemId: string;
  readonly source: string;
}) {
  return withArtifactTreeHold(params.artifactsDir, undefined, async () => {
    const runId = await readQuestionReviewRunId(params.artifactsDir);
    if (runId === undefined) {
      throw new Error("No active question-review run. Run next-step to publish the current assignments. Legacy file-review runs are archival; start a new audit to review this repository.");
    }
    const boundary = { root: params.root, artifactsDir: params.artifactsDir, runId };
    const workload = await readAuditQuestionWorkload(boundary);
    const issued = workload.work_items.find(({ binding }) => binding.assignment.assignment_id === params.workItemId);
    if (!issued) throw new Error("Review assignment is not in the current issued workload");
    const { bundle, sourceRoot } = await verifyCurrentQuestionInputs(params.root, params.artifactsDir);
    if (workload.source_root !== toPosixPath(sourceRoot)) {
      throw new Error("The issued snapshot is no longer current; run next-step before submitting.");
    }
    const ledger = await readAuditQuestionLedger(boundary);
    const { bindings } = await deriveCurrentQuestionBindings(bundle, sourceRoot, workload.source_files, ledger.reopens);
    const current = bindings.find(({ assignment }) => assignment.assignment_id === params.workItemId);
    if (!current || stableStringify(issued.binding) !== stableStringify({
      question: current.question, assignment: current.assignment, dependencies: current.dependencies,
    }) || stableStringify(workload.evidence.filter(item =>
      current.assignment.available_evidence_ids.includes(item.evidence_id))) !== stableStringify(current.evidence)) {
      throw new Error("The issued review assignment is no longer current; run next-step before submitting.");
    }
    const result = await submitAuditQuestionResult({
      ...boundary,
      assignmentId: params.workItemId,
      source: params.source,
    });
    return {
      run_id: runId,
      work_item_id: params.workItemId,
      submission_id: result.record.submission.submission_id,
      disposition: result.kind,
      // Submit server's success flag means the answer is durably present, not
      // that an idempotent replay made a new write. Disposition distinguishes them.
      written: true,
    };
  });
}

/** The argv an MCP request stands for: its root, and its artifacts dir when it names one. */
function mcpRequestArgv(request: { root: string; artifactsDir?: string }): string[] {
  return ["--root", request.root, ...(request.artifactsDir === undefined ? [] : ["--artifacts-dir", request.artifactsDir])];
}

/**
 * `audit-code mcp` — serve the submit-only MCP tool over stdio. The server is
 * imported here, not at the top, so no other command loads the MCP SDK. The
 * paths resolve exactly as `--root` / `--artifacts-dir` resolve for the CLI.
 */
export async function cmdMcp(_argv: string[]): Promise<void> {
  const submitServer = await import("audit-tools/shared/mcp/submitServer");
  await submitServer.serveSubmitMcpOverStdio({
    name: "audit-code",
    submissionDescription: "Submit one current review assignment's answer as a JSON object. " +
      "The tool validates the issued binding and durably accepts it; an exact replay is a no-op. " +
      "Correct any refusal before proceeding. Run next-step afterward.",
    // sites-pinned: tests/audit/result-submit.test.ts
    gateSubmission: {
      lanes: SUPPORTED_GATE_SUBMISSIONS,
      submit: async request => {
        const argv = mcpRequestArgv(request);
        return submitGateResult({ artifactsDir: getArtifactsDir(argv), lane: request.lane, source: request.source });
      },
    },
    submit: async (request) => {
      const argv = mcpRequestArgv(request);
      return submitWorkItemResult({
        root: getRootDir(argv),
        artifactsDir: getArtifactsDir(argv),
        workItemId: request.workItemId,
        source: request.source,
      });
    },
  });
}

/**
 * `audit-code submit --work-item <id> --from <file>` — the route for a host
 * without the MCP tool. The reader writes its result JSON with its file tool to
 * any file; only the id and that path pass the shell, so no payload is escaped.
 * Exit 0 means the response has been durably accepted or was an exact replay.
 */
export async function cmdSubmit(argv: string[]): Promise<void> {
  const workItemId = getFlag(argv, "--work-item");
  const from = getFlag(argv, "--from");
  if (!workItemId || !from) {
    throw new Error(
      "submit requires --work-item <id> and --from <file>: write the result JSON to any file with your file tool, " +
        "then pass the work-item id your prompt names and that file's path.",
    );
  }
  const artifactsDir = getArtifactsDir(argv);
  const check = await submitWorkItemResult({
    root: getRootDir(argv),
    artifactsDir,
    workItemId,
    source: await readFile(from, "utf8"),
  });
  outputJson(
    {
      artifacts_dir: artifactsDir,
      submitted_from: resolve(from),
      ...check,
    },
  );
}


function withActiveQuestionAdminRun<T>(artifactsDir: string, run: (runId: string) => Promise<T>): Promise<T> {
  return withArtifactTreeHold(artifactsDir, undefined, async () => {
    const runId = await readQuestionReviewRunId(artifactsDir);
    if (!runId) throw new Error("No active question-review run; finished reports are immutable.");
    return run(runId);
  });
}

// sites-pinned: tests/audit/question-consolidation-cli.test.ts
// Dispatcher-only: the file is the explicit reviewed same-repair decision,
// not an invitation to infer or auto-merge from similar wording.
export async function cmdConsolidateFindings(argv: string[]): Promise<void> {
  const from = getFlag(argv, "--from");
  if (!from) throw new Error("consolidate-findings requires --from <operator-reviewed decision JSON>");
  const decision = ReviewFindingConsolidationSchema.parse(JSON.parse(await readFile(from, "utf8")));
  const artifactsDir = getArtifactsDir(argv);
  const root = getRootDir(argv);
  const receipt = await withActiveQuestionAdminRun(artifactsDir, async runId => {
    const { bundle, sourceRoot } = await verifyCurrentQuestionInputs(root, artifactsDir);
    const context = await deriveQuestionCycleUnlocked({ root, artifactsDir, sourceRoot, bundle, readOnlyRunId: runId });
    const disposition = await consolidateAuditQuestionFindings({ root, artifactsDir, runId,
      decision, questions: context.bindings.map(binding => binding.question),
      dependenciesByQuestion: context.dependenciesByQuestion, evidence: context.evidence });
    return { run_id: runId, decision_id: decision.decision_id, disposition };
  });
  outputJson(receipt);
}

/** Reopen exactly the named current answers. Normal next-step emits replacement work. */
export async function cmdReopenQuestions(argv: string[]): Promise<void> {
  const from = getFlag(argv, "--from");
  if (!from) throw new Error("reopen-questions requires --from <operator-approved reopen JSON>");
  const request = ReviewReopenRequestSchema.parse(JSON.parse(await readFile(from, "utf8")));
  const artifactsDir = getArtifactsDir(argv);
  const root = getRootDir(argv);
  const receipt = await withActiveQuestionAdminRun(artifactsDir, async runId => {
    const { bundle, sourceRoot } = await verifyCurrentQuestionInputs(root, artifactsDir, request.tooling_transition);
    const context = await deriveQuestionCycleUnlocked({ root, artifactsDir, sourceRoot, bundle, readOnlyRunId: runId });
    const disposition = await reopenAuditQuestions({
      root, artifactsDir, runId, request, qualification: bundle.review_tooling_qualification,
      questions: context.bindings.map(({ question }) => question),
      dependenciesByQuestion: context.dependenciesByQuestion,
    });
    return { run_id: runId, reopen_id: request.reopen_id, disposition, next: nextStepCommand(root, artifactsDir) };
  });
  outputJson(receipt);
}
