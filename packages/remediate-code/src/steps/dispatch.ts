import { mkdir, rename } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  ItemSpec,
  RemediationBlock,
} from "../state/types.js";
import {
  readJsonFile,
  readOptionalJsonFile,
  writeJsonFile,
  writeTextFile,
  formatValidationIssues,
  isRecord,
  detectRepoConventions,
  formatRepoConventions,
  type FindingTheme,
  type SessionConfig,
} from "@audit-tools/shared";
import {
  validateClarificationRequest,
  validateDocumentResponse,
  validateItemSpec,
} from "../validation/remediationState.js";
import { validateImplementWorkerResult } from "../validation/artifacts.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
  type DispatchModelHint,
  type DispatchPlanItem,
  type DocumentWorkerResult,
  type ImplementWorkerResult,
  type RemediationDispatchPlan,
} from "./types.js";
import {
  classifyFindingRisk,
  specIndicatesNoChange,
  dependenciesSatisfied,
  isTerminalStatus,
} from "./stepUtils.js";
import { scheduleWave, buildDispatchQuota } from "./waveScheduler.js";
import { ESTIMATED_FINDING_OVERHEAD_TOKENS, ESTIMATED_BLOCK_BASE_TOKENS } from "../phases/plan.js";
import { resnapshotAffectedFileHashes } from "../utils/fileIntegrity.js";

export interface DispatchOptions {
  root: string;
  artifactsDir: string;
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

async function tryLoadExistingDocumentResult(resultPath: string): Promise<boolean> {
  if (!existsSync(resultPath)) return false;
  try {
    const result = await readJsonFile<DocumentWorkerResult>(resultPath);
    const issues = validateDocumentResponse(result);
    return issues.filter((i) => i.severity === "error").length === 0;
  } catch {
    return false;
  }
}

async function tryLoadExistingImplementResult(
  resultPath: string,
): Promise<ImplementWorkerResult | undefined> {
  if (!existsSync(resultPath)) return undefined;
  try {
    const result = await readJsonFile<unknown>(resultPath);
    assertImplementWorkerResult(result, resultPath);
    return result;
  } catch {
    return undefined;
  }
}

function documentedFindingIdsForBlock(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  return block.items.filter((findingId) => {
    const item = state.items?.[findingId];
    return item?.status === "documented" && Boolean(item.item_spec);
  });
}

function implementResultCoversFindings(
  result: ImplementWorkerResult,
  findingIds: string[],
): boolean {
  const resultIds = new Set(result.item_results.map((item) => item.finding_id));
  return findingIds.every((findingId) => resultIds.has(findingId));
}

async function archiveIncompleteImplementResult(resultPath: string): Promise<void> {
  if (!existsSync(resultPath)) return;
  const archivedPath = `${resultPath}.stale-${Date.now()}`;
  await rename(resultPath, archivedPath);
}

function runDir(artifactsDir: string, runId: string, phase: string): string {
  return join(artifactsDir, "runs", runId, phase);
}

function dispatchPlanPath(
  artifactsDir: string,
  runId: string,
  phase: string,
): string {
  return join(runDir(artifactsDir, runId, phase), "dispatch-plan.json");
}

const SENSITIVE_LENSES = new Set([
  "security",
  "data_integrity",
  "reliability",
]);
const SAFE_LENS_PATTERN =
  /\b(style|format|lint|typo|whitespace|cosmetic|config)\b/i;

export function buildDocumentModelHint(finding: Finding): DispatchModelHint {
  const deepReasons: string[] = [];
  if (finding.severity === "critical" || finding.severity === "high") {
    deepReasons.push(`severity_${finding.severity}`);
  }
  if (SENSITIVE_LENSES.has(finding.lens.toLowerCase())) {
    deepReasons.push(`sensitive_lens_${finding.lens}`);
  }
  if (deepReasons.length > 0) {
    return { tier: "deep", reasons: deepReasons };
  }

  const lowRisk =
    (finding.severity === "low" || finding.severity === "info") &&
    finding.confidence === "high";
  if (lowRisk && SAFE_LENS_PATTERN.test(finding.lens)) {
    return { tier: "small", reasons: ["low_severity_safe_lens"] };
  }

  return { tier: "standard", reasons: ["default_document_item"] };
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WALK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "out",
  ".next", ".turbo", ".audit-artifacts", ".remediation-artifacts",
]);

/** Bounded recursive scan for test files under `root` (skips vendor/build dirs). */
function walkTestFiles(root: string, max = 400): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0 && out.length < max) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > 20000) return out;
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".test-")) continue;
        stack.push(join(dir, entry.name));
      } else if (TEST_FILE_RE.test(entry.name)) {
        out.push(join(dir, entry.name));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/**
 * Best-effort: repo-relative test files that reference any of `sourceFiles` (by
 * module basename). Pulling them into a block's access lets the worker that
 * changes or removes a symbol also fix the tests that assert it, instead of
 * leaving orphaned test breakage for a separate central mop-up. Matching is
 * deliberately loose (a false positive only grants slightly broader, harmless
 * write access; a false negative is the failure mode we want to avoid).
 */
export interface TestFileEntry {
  rel: string;
  content: string;
}

/**
 * Walk the repo ONCE and read every test file's content (bounded). Built once per
 * dispatch and shared across all blocks so the filesystem walk + reads are not
 * repeated per block.
 */
export function buildTestFileIndex(root: string): TestFileEntry[] {
  const index: TestFileEntry[] = [];
  for (const testPath of walkTestFiles(root)) {
    let content: string;
    try {
      content = readFileSync(testPath, "utf8");
    } catch {
      continue;
    }
    index.push({ rel: relative(root, testPath).replace(/\\/g, "/"), content });
  }
  return index;
}

export function collectReferencingTests(
  index: TestFileEntry[],
  sourceFiles: string[],
): string[] {
  if (sourceFiles.length === 0 || index.length === 0) return [];
  const basenames = sourceFiles
    .map((f) => (f.split(/[/\\]/).pop() ?? f).replace(/\.[cm]?[jt]sx?$/, ""))
    .filter((b) => b.length > 1);
  if (basenames.length === 0) return [];
  const needles = basenames.map(
    (b) => new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
  );
  const sourceSet = new Set(sourceFiles.map((f) => f.replace(/\\/g, "/")));
  const result: string[] = [];
  for (const { rel, content } of index) {
    if (sourceSet.has(rel)) continue;
    if (needles.some((re) => re.test(content))) result.push(rel);
  }
  return result;
}

/**
 * The files an implement worker may touch for a finding: the pre-document
 * affected_files PLUS any files the document phase declared in the item_spec's
 * `touched_files` (the document worker can correct or extend the file set when
 * the real fix lives elsewhere). Deduped.
 */
function itemFiles(finding: Finding, spec?: ItemSpec): string[] {
  const files = finding.affected_files.map((f) => f.path);
  if (spec?.touched_files) files.push(...spec.touched_files);
  return [...new Set(files)];
}

/**
 * Repo-relative paths every finding in a block touches, deduped — recomputed
 * from the documented item_spec (not the frozen pre-document finding) so a fix
 * the document phase relocated is inside the implementer's declared write set.
 */
function blockAffectedFiles(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  const files = block.items.flatMap((findingId) => {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) return [];
    return itemFiles(finding, state.items?.[findingId]?.item_spec);
  });
  return [...new Set(files)];
}

/**
 * Construct the DispatchPlanItem for an implement task. Single source of truth
 * so prepareImplementDispatch and mergeImplementResults stay in lockstep on item
 * shape.
 */
function buildImplementDispatchItem(
  block: RemediationBlock,
  state: RemediationState,
  dir: string,
): DispatchPlanItem {
  const taskId = `implement-${block.block_id}`;
  const blockFiles = blockAffectedFiles(block, state);
  const resultPath = join(dir, `${taskId}.result.json`);
  return {
    task_id: taskId,
    block_id: block.block_id,
    prompt_path: join(dir, `${taskId}.md`),
    result_path: resultPath,
    model_hint: buildImplementModelHint(block, state),
    access: {
      read_paths: blockFiles,
      write_paths: [...blockFiles, resultPath],
    },
  };
}

/**
 * Construct the DispatchPlanItem for a document task. Single source of truth so
 * prepareDocumentDispatch and mergeDocumentResults stay in lockstep on item shape.
 */
function buildDocumentDispatchItem(finding: Finding, dir: string): DispatchPlanItem {
  const taskId = `document-${finding.id}`;
  const promptPath = join(dir, `${taskId}.md`);
  const resultPath = join(dir, `${taskId}.result.json`);
  return {
    task_id: taskId,
    finding_id: finding.id,
    prompt_path: promptPath,
    result_path: resultPath,
    model_hint: buildDocumentModelHint(finding),
    access: {
      read_paths: finding.affected_files.map((f) => f.path),
      write_paths: [resultPath],
    },
  };
}

export function buildImplementModelHint(
  block: RemediationBlock,
  state: RemediationState,
): DispatchModelHint {
  const deepReasons: string[] = [];
  let allSafe = true;
  let maxSeverityRank = 0;
  const severityRanks: Record<string, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };

  for (const findingId of block.items) {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    const rank = severityRanks[finding.severity] ?? 0;
    if (rank > maxSeverityRank) maxSeverityRank = rank;
    if (item?.item_spec) {
      const { tier } = classifyFindingRisk(
        finding,
        item.item_spec as import("../state/types.js").ItemSpec,
      );
      if (tier === "context_dependent") {
        deepReasons.push(`context_dependent_${findingId}`);
      }
      if (tier !== "safe") {
        allSafe = false;
      }
    } else {
      allSafe = false;
    }
  }

  if (maxSeverityRank >= 5) {
    deepReasons.push("critical_severity");
  }
  if (block.items.length >= 5) {
    deepReasons.push("large_block");
  }
  if (deepReasons.length > 0) {
    return { tier: "deep", reasons: deepReasons };
  }

  if (allSafe && block.items.length === 1 && maxSeverityRank <= 2) {
    return { tier: "small", reasons: ["all_safe_single_finding"] };
  }

  return { tier: "standard", reasons: ["default_implement_block"] };
}

// Phase 7A: reuse the auditor's synthesis theme (no new LLM pass) to hand the
// worker the shared root-cause fix pattern when this finding carries one.
// Mirrors the wording used in the in-process phase (`phases/document.ts`).
function themeHint(
  finding: Finding,
  themes: FindingTheme[] | undefined,
): string {
  if (!finding.theme_id) return "";
  const theme = themes?.find((t) => t.theme_id === finding.theme_id);
  if (!theme) return "";
  return `\nSYNTHESIS THEME (${theme.theme_id} — ${theme.title}):\nRoot cause: ${theme.root_cause}\nSuggested fix pattern: ${theme.suggested_fix_pattern}\nApply this shared pattern where it fits this finding.\n`;
}

function findingPrompt(
  finding: Finding,
  resultPath: string,
  conventions: string,
  themeHintText: string,
): string {
  return `
# Document Remediation Item

You are documenting one remediation item. Use only the finding context below.

## Finding

- ID: ${finding.id}
- Title: ${finding.title}
- Severity: ${finding.severity}
- Confidence: ${finding.confidence}
- Lens: ${finding.lens}
- Summary: ${finding.summary}
- Files: ${finding.affected_files.map((file) => file.path).join(", ")}

## Evidence

${(finding.evidence ?? []).map((item) => `- ${item}`).join("\n")}
${themeHintText}${conventions ? `\n${conventions}\n` : ""}
## Output

Write JSON to exactly:

\`${resultPath}\`

Use one of these shapes:

\`\`\`json
{
  "type": "item_spec",
  "item_spec": {
    "finding_id": "${finding.id}",
    "concrete_change": "...",
    "no_change": false,
    "touched_files": ["repo/relative/path.ts"],
    "tests_to_write": [{ "name": "...", "assertions": ["..."] }],
    "not_applicable_steps": []
  }
}
\`\`\`

Set \`no_change\` to \`true\` when the existing code is already correct and no
source changes are needed. When \`no_change\` is true, \`concrete_change\` should
explain why the code is already correct.

List every repo-relative path your fix will create or modify in \`touched_files\`.
If the real fix belongs in files other than the \`Files\` listed above, put the
correct paths there — the implementer is granted write access to exactly these
(falling back to the finding's files only if you omit \`touched_files\`).

If any remediation steps do not apply to this finding, list them in
\`not_applicable_steps\`. Each entry must be an object with a \`step\` field
(one of: \`"Document"\`, \`"Write Tests"\`, \`"Refactor Code"\`,
\`"Verify Code Against Tests"\`, \`"Verify Code Against Documentation"\`) and a
required \`rationale\` string explaining why it does not apply. Example:

\`\`\`json
"not_applicable_steps": [
  { "step": "Write Tests", "rationale": "Finding is a config-only change with no testable logic." }
]
\`\`\`

\`\`\`json
{
  "type": "clarification_request",
  "clarifications": [
    {
      "finding_id": "${finding.id}",
      "category": "scope_of_fix",
      "description": "..."
    }
  ]
}
\`\`\`

## File access

Read: ${finding.affected_files.map((f) => f.path).join(", ")}
Write: ${resultPath}
Do not read or write files outside these paths.
`;
}

function implementPrompt(
  block: RemediationBlock,
  state: RemediationState,
  resultPath: string,
  conventions: string,
): string {
  const items = block.items.flatMap((findingId) => {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((entry) => entry.id === findingId);
    if (!item?.item_spec || !finding) return [];
    // Only render items that still need implementing — never a resolved item
    // from a prior wave or one the user skipped (deemed_inappropriate/ignored).
    if (item.status !== "documented") return [];
    return [{ finding, spec: item.item_spec }];
  });

  return `
# Implement Remediation Block

You are implementing one bounded remediation block. Edit the files needed for the
findings in this prompt, and you MAY create new files (e.g. a test file or an
extracted module) within the SAME package as those files when a finding's change
calls for it. Do not edit unrelated files in other packages, and do not change
remediation state files directly.

## Block

- Block ID: ${block.block_id}
- Findings: ${items.map(({ finding }) => finding.id).join(", ")}

## Items

${items
  .map(
    ({ finding, spec }) => `
### ${finding.id} - ${finding.title}

- Files: ${itemFiles(finding, spec).join(", ")}
- Summary: ${finding.summary}
- Concrete change: ${spec.concrete_change}
- Tests to write: ${spec.tests_to_write
      .map((test) => `${test.name}: ${test.assertions.join("; ")}`)
      .join(" | ")}
`,
  )
  .join("\n")}
${conventions ? `\n${conventions}\n` : ""}
## Output

After editing and verifying the block, write JSON to exactly:

\`${resultPath}\`

\`\`\`json
{
  "contract_version": "${REMEDIATION_WORKER_RESULT_CONTRACT_VERSION}",
  "phase": "implement",
  "item_results": [
    {
      "finding_id": "FINDING-ID",
      "status": "resolved",
      "evidence": ["test or verification evidence"]
    }
  ]
}
\`\`\`

For an item you cannot safely finish, set \`status\` to \`blocked\` and include
\`failure_reason\`. Stop after writing the result JSON.

## File access

Read and write: ${[...new Set(items.flatMap(({ finding, spec }) => itemFiles(finding, spec)))].join(", ")}
You may also create new files within the same package as those files (e.g. tests
or extracted modules) when a finding requires it.
If your change renames, moves, or removes a symbol, also update the existing test
files that reference it — fixing tests for a changed surface is part of this
block, not a later cleanup. Test files that reference these files are included in
your write access.
Write result: ${resultPath}
Do not modify unrelated files outside these paths or files in other packages.
`;
}

async function loadStateOrThrow(
  artifactsDir: string,
): Promise<RemediationState> {
  const state = await new StateStore(artifactsDir).loadState();
  if (!state) {
    throw new Error(`No remediation state found at ${join(artifactsDir, "state.json")}.`);
  }
  return state;
}

export async function prepareDocumentDispatch(
  options: DispatchOptions,
  runId: string,
  onlyFindingId?: string,
  waveOptions?: { hostMaxConcurrent?: number; sessionConfig?: SessionConfig | null },
): Promise<RemediationDispatchPlan> {
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.plan || !state.items) {
    throw new Error("Cannot prepare document dispatch without plan and items.");
  }

  const dir = runDir(options.artifactsDir, runId, "document");
  await mkdir(dir, { recursive: true });

  // Phase 7A: detect house style once per dispatch (filesystem scan) and inject
  // "match the surrounding code" guidance into every worker prompt.
  const conventions = formatRepoConventions(detectRepoConventions(options.root));

  const seenFindingIds = new Set<string>();
  const candidateFindings = state.plan.findings.filter((finding) => {
    const item = state.items?.[finding.id];
    if (
      (!onlyFindingId || finding.id === onlyFindingId) &&
      item &&
      item.status === "pending" &&
      !seenFindingIds.has(finding.id)
    ) {
      seenFindingIds.add(finding.id);
      return true;
    }
    return false;
  });

  const items: DispatchPlanItem[] = [];
  let reconciledCount = 0;
  for (const finding of candidateFindings) {
    const item = buildDocumentDispatchItem(finding, dir);

    if (await tryLoadExistingDocumentResult(item.result_path)) {
      console.log(`Reusing existing document result for ${finding.id}`);
      reconciledCount++;
      continue;
    }

    await writeTextFile(
      item.prompt_path,
      findingPrompt(
        finding,
        item.result_path,
        conventions,
        themeHint(finding, state.plan.themes),
      ),
    );
    items.push(item);
  }
  if (reconciledCount > 0) {
    console.log(`Reconciliation: reused ${reconciledCount} existing document results.`);
  }

  const plan: RemediationDispatchPlan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "document",
    run_id: runId,
    repo_root: options.root,
    artifacts_dir: options.artifactsDir,
    items,
  };

  await writeJsonFile(dispatchPlanPath(options.artifactsDir, runId, "document"), plan);

  const schedule = await scheduleWave({
    hostMaxConcurrent: waveOptions?.hostMaxConcurrent,
    sessionConfig: waveOptions?.sessionConfig ?? null,
    itemCount: items.length,
    estimatedSlotTokens: items.map(() => ESTIMATED_FINDING_OVERHEAD_TOKENS),
  });
  process.stderr.write(
    `[remediate-code] dispatch: document wave_size=${schedule.wave_size} of ${items.length} item(s) ` +
      `source=${schedule.source} cap=${schedule.binding_cap ?? "none"}\n`,
  );
  const quota = buildDispatchQuota(runId, "document", schedule);
  await writeJsonFile(join(dir, "dispatch-quota.json"), quota);

  return plan;
}

export async function mergeDocumentResults(
  options: DispatchOptions,
  runId: string,
): Promise<RemediationState> {
  const plan = await readJsonFile<RemediationDispatchPlan>(
    dispatchPlanPath(options.artifactsDir, runId, "document"),
  );
  if (
    plan.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION ||
    plan.phase !== "document"
  ) {
    throw new Error("Document dispatch plan has an unsupported contract.");
  }

  const store = new StateStore(options.artifactsDir);
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.plan || !state.items) {
    throw new Error("Cannot merge document results without plan and items.");
  }

  const dir = runDir(options.artifactsDir, runId, "document");
  const plannedFindingIds = new Set(
    plan.items.map((item) => item.finding_id).filter((id): id is string => typeof id === "string"),
  );
  const itemsToMerge = [...plan.items];
  for (const finding of state.plan.findings) {
    const stateItem = state.items[finding.id];
    if (!stateItem || stateItem.status !== "pending" || plannedFindingIds.has(finding.id)) {
      continue;
    }

    const item = buildDocumentDispatchItem(finding, dir);
    if (!(await tryLoadExistingDocumentResult(item.result_path))) {
      continue;
    }

    itemsToMerge.push(item);
  }

  const clarifications: ClarificationRequest[] = [];
  for (const item of itemsToMerge) {
    if (!item.finding_id) {
      throw new Error(`Document dispatch item ${item.task_id} is missing finding_id.`);
    }
    if (!existsSync(item.result_path)) {
      console.warn(`Missing document worker result: ${item.result_path} — marking ${item.finding_id} blocked.`);
      const stateItem = state.items[item.finding_id];
      stateItem.status = "blocked";
      markTerminal(stateItem);
      stateItem.failure_reason = `Document worker did not produce a result file: ${item.result_path}`;
      continue;
    }

    const result = await readJsonFile<DocumentWorkerResult>(item.result_path);
    const issues = validateDocumentResponse(result);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) {
      console.warn(`Invalid document result for ${item.finding_id} — marking blocked.`);
      const stateItem = state.items[item.finding_id];
      stateItem.status = "blocked";
      markTerminal(stateItem);
      stateItem.failure_reason =
        `Invalid document result:\n${formatValidationIssues(errors)}`;
      continue;
    }

    if (result.type === "item_spec") {
      const spec = result.item_spec as ItemSpec;
      const specIssues = validateItemSpec(spec).filter(
        (issue) => issue.severity === "error",
      );
      if (specIssues.length > 0) {
        console.warn(`Invalid item spec for ${item.finding_id} — marking blocked.`);
        const stateItem = state.items[item.finding_id];
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason = formatValidationIssues(specIssues);
        continue;
      }
      const stateItem = state.items[item.finding_id];
      stateItem.item_spec = spec;
      stateItem.status = "documented";
      markStarted(stateItem);
      await writeJsonFile(
        join(options.artifactsDir, `item_spec_${item.finding_id}.json`),
        spec,
      );
      continue;
    }

    for (const clarification of result.clarifications ?? []) {
      const clarificationIssues = validateClarificationRequest(clarification);
      const clarificationErrors = clarificationIssues.filter(
        (issue) => issue.severity === "error",
      );
      if (clarificationErrors.length > 0) {
        throw new Error(formatValidationIssues(clarificationErrors));
      }
      clarifications.push(clarification as ClarificationRequest);
    }
  }

  if (clarifications.length > 0) {
    await writeJsonFile(
      join(options.artifactsDir, "clarification_request.json"),
      clarifications,
    );
    state.status = "waiting_for_clarification";
    state.clarifications = clarifications;
  } else {
    const remainingPending = state.plan?.findings.some(
      (f) => state.items?.[f.id]?.status === "pending",
    );
    state.status = remainingPending ? "planning" : "documenting";
    state.clarifications = [];
    state.closing_plan ??= { action: "none" };
  }

  const mergedItems = state.items;
  const mergedDocumented = itemsToMerge.filter(
    (item) => item.finding_id && mergedItems[item.finding_id]?.status === "documented",
  ).length;
  const rejectedDocuments = itemsToMerge.filter(
    (item) => item.finding_id && mergedItems[item.finding_id]?.status === "blocked",
  ).length;
  process.stderr.write(
    `[remediate-code] dispatch: merged ${mergedDocumented} document result(s), ` +
      `${rejectedDocuments} rejected, ${clarifications.length} clarification(s)\n`,
  );

  await store.saveState(state);
  return state;
}

export async function prepareImplementDispatch(
  options: DispatchOptions,
  runId: string,
  onlyBlockId?: string,
  waveOptions?: { hostMaxConcurrent?: number; sessionConfig?: SessionConfig | null },
): Promise<RemediationDispatchPlan> {
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.plan || !state.items) {
    throw new Error("Cannot prepare implement dispatch without plan and items.");
  }

  const dir = runDir(options.artifactsDir, runId, "implement");
  await mkdir(dir, { recursive: true });

  // Phase 7A: same house-style guidance as the document dispatch, so the
  // implementing worker also matches the surrounding code.
  const conventions = formatRepoConventions(detectRepoConventions(options.root));

  const seenBlockIds = new Set<string>();
  const candidateBlocks = state.plan.blocks.filter((block) => {
    if (onlyBlockId && block.block_id !== onlyBlockId) return false;
    if (seenBlockIds.has(block.block_id)) return false;
    // Honor block dependencies: a dependent block is not dispatched until every
    // prerequisite block is fully resolved, so dependency-ordered work runs in
    // separate waves rather than racing on the main tree.
    if (!dependenciesSatisfied(block, state)) return false;
    const hasWork = block.items.some((findingId) => {
      const item = state.items?.[findingId];
      return item?.status === "documented" && item.item_spec;
    });
    if (hasWork) {
      seenBlockIds.add(block.block_id);
      return true;
    }
    return false;
  });

  // Walk the repo for test files ONCE per dispatch (not once per block) and cache
  // their contents; collectReferencingTests then matches in memory.
  const testIndex = buildTestFileIndex(options.root);

  const items: DispatchPlanItem[] = [];
  let reconciledCount = 0;
  // Wave-time file-disjointness: mergeBlocksSharingFiles enforced disjoint
  // affected_files at plan time, but the document phase's touched_files and the
  // pulled-in test files can introduce NEW shared paths. Track the write paths
  // already claimed by this wave and defer any block that would collide, so two
  // workers never edit the same file concurrently in the main tree. A deferred
  // block stays `documented` and re-dispatches in a later wave.
  const claimedWritePaths = new Set<string>();
  let deferredForFileConflict = 0;
  for (const block of candidateBlocks) {
    const item = buildImplementDispatchItem(block, state, dir);

    // Pull test files that reference this block's source into its access, so the
    // worker that changes or removes a symbol also fixes the tests that assert it
    // (otherwise their breakage is orphaned for a separate central mop-up).
    const referencingTests = collectReferencingTests(
      testIndex,
      blockAffectedFiles(block, state),
    );
    if (referencingTests.length > 0 && item.access) {
      item.access.read_paths = [
        ...new Set([...item.access.read_paths, ...referencingTests]),
      ];
      item.access.write_paths = [
        ...new Set([...item.access.write_paths, ...referencingTests]),
      ];
    }

    // Reconcile an already-produced result regardless of wave packing.
    const documentedFindingIds = documentedFindingIdsForBlock(block, state);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    if (existingResult) {
      if (implementResultCoversFindings(existingResult, documentedFindingIds)) {
        console.log(`Reusing existing implement result for block ${block.block_id}`);
        reconciledCount++;
        continue;
      }
      process.stderr.write(
        `[remediate-code] dispatch: existing implement result for block ${block.block_id} ` +
          `does not cover ${documentedFindingIds.length} still-documented item(s); re-dispatching\n`,
      );
      await archiveIncompleteImplementResult(item.result_path);
    }

    const writePaths = (item.access?.write_paths ?? []).filter(
      (p) => p !== item.result_path,
    );
    if (writePaths.some((p) => claimedWritePaths.has(p))) {
      deferredForFileConflict++;
      continue;
    }
    for (const p of writePaths) claimedWritePaths.add(p);

    await writeTextFile(
      item.prompt_path,
      implementPrompt(block, state, item.result_path, conventions),
    );
    items.push(item);
  }
  if (reconciledCount > 0) {
    console.log(`Reconciliation: reused ${reconciledCount} existing implement results.`);
  }
  if (deferredForFileConflict > 0) {
    process.stderr.write(
      `[remediate-code] dispatch: deferred ${deferredForFileConflict} block(s) with overlapping write paths to a later wave.\n`,
    );
  }

  // Host-dispatched implement workers edit the main tree directly (their prompts
  // use repo-root-relative paths), so per-block worktrees were created but never
  // written to — mergeWorktree no-op'd and the `remediate-<block>` branches only
  // collided across runs. Parallel safety instead comes from the planner: blocks
  // that share a file are merged (mergeBlocksSharingFiles) and dependency-ordered
  // blocks dispatch in separate waves (dependenciesSatisfied), so the blocks in
  // any one wave are file-disjoint and safe to edit concurrently in place.

  const plan: RemediationDispatchPlan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: runId,
    repo_root: options.root,
    artifacts_dir: options.artifactsDir,
    items,
  };
  await writeJsonFile(dispatchPlanPath(options.artifactsDir, runId, "implement"), plan);

  const schedule = await scheduleWave({
    hostMaxConcurrent: waveOptions?.hostMaxConcurrent,
    sessionConfig: waveOptions?.sessionConfig ?? null,
    itemCount: items.length,
    estimatedSlotTokens: items.map(() => ESTIMATED_BLOCK_BASE_TOKENS),
  });
  process.stderr.write(
    `[remediate-code] dispatch: implement wave_size=${schedule.wave_size} of ${items.length} item(s) ` +
      `source=${schedule.source} cap=${schedule.binding_cap ?? "none"}\n`,
  );
  const quota = buildDispatchQuota(runId, "implement", schedule);
  await writeJsonFile(join(dir, "dispatch-quota.json"), quota);

  return plan;
}

function assertImplementWorkerResult(value: unknown, path: string): asserts value is ImplementWorkerResult {
  const issues = validateImplementWorkerResult(value, path).filter((i) => i.severity === "error");
  if (issues.length > 0) {
    throw new Error(formatValidationIssues(issues));
  }
}

export async function mergeImplementResults(
  options: DispatchOptions,
  runId: string,
): Promise<RemediationState> {
  const plan = await readJsonFile<RemediationDispatchPlan>(
    dispatchPlanPath(options.artifactsDir, runId, "implement"),
  );
  if (
    plan.contract_version !== REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION ||
    plan.phase !== "implement"
  ) {
    throw new Error("Implement dispatch plan has an unsupported contract.");
  }

  const store = new StateStore(options.artifactsDir);
  const state = await loadStateOrThrow(options.artifactsDir);
  if (!state.items) {
    throw new Error("Cannot merge implement results without items.");
  }

  const dir = runDir(options.artifactsDir, runId, "implement");
  const plannedBlockIds = new Set(
    plan.items.map((item) => item.block_id).filter((id): id is string => typeof id === "string"),
  );
  const itemsToMerge = [...plan.items];
  for (const block of state.plan?.blocks ?? []) {
    if (plannedBlockIds.has(block.block_id)) {
      continue;
    }
    const hasDocumentedWork = block.items.some((findingId) => {
      const stateItem = state.items?.[findingId];
      return stateItem?.status === "documented" && stateItem.item_spec;
    });
    if (!hasDocumentedWork) {
      continue;
    }

    const item = buildImplementDispatchItem(block, state, dir);
    const existingResult = await tryLoadExistingImplementResult(item.result_path);
    const documentedFindingIds = documentedFindingIdsForBlock(block, state);
    if (
      !existingResult ||
      !implementResultCoversFindings(existingResult, documentedFindingIds)
    ) {
      continue;
    }

    itemsToMerge.push(item);
  }

  for (const item of itemsToMerge) {
    if (!existsSync(item.result_path)) {
      console.warn(`Missing implement worker result: ${item.result_path} — marking items blocked.`);
      const block = item.block_id
        ? state.plan?.blocks.find((b) => b.block_id === item.block_id)
        : undefined;
      for (const findingId of block?.items ?? []) {
        const stateItem = state.items[findingId];
        // Don't flip a terminal item (resolved, or user-skipped
        // deemed_inappropriate/ignored) to blocked — only items that were
        // actually awaiting this worker's result.
        if (!stateItem || isTerminalStatus(stateItem.status)) continue;
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          `Implementation worker did not produce a result file: ${item.result_path}`;
      }
      continue;
    }
    const result = await readJsonFile<unknown>(item.result_path);
    assertImplementWorkerResult(result, item.result_path);
    for (const itemResult of result.item_results) {
      const stateItem = state.items[itemResult.finding_id];
      if (!stateItem) {
        throw new Error(`Unknown finding_id in implement result: ${itemResult.finding_id}`);
      }
      // A worker may report a finding that is already terminal (user-skipped, or
      // resolved in a prior wave) — never let a result resurrect or overwrite it.
      if (isTerminalStatus(stateItem.status)) {
        continue;
      }
      if (itemResult.status === "resolved") {
        const spec = stateItem.item_spec;
        const isNoChange = specIndicatesNoChange(spec);
        stateItem.status = isNoChange ? "resolved_no_change" : "resolved";
        markTerminal(stateItem);
        stateItem.last_successful_step = "Verify Code Against Documentation";
        if (itemResult.evidence?.length) {
          await writeJsonFile(
            join(
              options.artifactsDir,
              `result_${itemResult.finding_id}_verify_code_against_documentation.json`,
            ),
            {
              finding_id: itemResult.finding_id,
              passed: true,
              reason: itemResult.evidence,
            },
          );
        }
      } else {
        stateItem.status = "blocked";
        markTerminal(stateItem);
        stateItem.failure_reason =
          itemResult.failure_reason ?? "Implementation worker blocked.";
      }
    }
  }

  // Re-baseline affected-file hashes: the implement phase legitimately rewrites
  // these files, so a later integrity check must not flag the run's own edits as
  // a stale plan when re-attempting any remaining blocked findings.
  if (state.plan?.findings?.length) {
    resnapshotAffectedFileHashes(options.root, state.plan.findings);
  }

  const mergedFindingIds = new Set(
    itemsToMerge.flatMap((item) => {
      if (!item.block_id) return [];
      const block = state.plan?.blocks.find((b) => b.block_id === item.block_id);
      return block?.items ?? [];
    }),
  );
  let implementResolved = 0;
  let implementRejected = 0;
  for (const findingId of mergedFindingIds) {
    const status = state.items[findingId]?.status;
    if (status === "resolved" || status === "resolved_no_change") implementResolved++;
    else if (status === "blocked") implementRejected++;
  }
  process.stderr.write(
    `[remediate-code] dispatch: merged ${implementResolved} implement result(s), ` +
      `${implementRejected} rejected\n`,
  );

  // Route back to documenting while documented work remains (later dependency
  // waves, or blocks deferred this wave because a prerequisite was still
  // running) so the next next-step dispatches the now-ready blocks; otherwise
  // advance to implementing → triage.
  const moreToImplement = Object.values(state.items).some(
    (it) => it.status === "documented" && Boolean(it.item_spec),
  );
  state.status = moreToImplement ? "documenting" : "implementing";
  await store.saveState(state);
  return state;
}

export async function readExtractedPlanIfPresent(
  artifactsDir: string,
): Promise<unknown | undefined> {
  return readOptionalJsonFile(join(artifactsDir, "extracted-plan.json"));
}

export async function readDispatchPlan(
  artifactsDir: string,
  runId: string,
  phase: "document" | "implement",
): Promise<RemediationDispatchPlan> {
  return readJsonFile(dispatchPlanPath(artifactsDir, runId, phase));
}
