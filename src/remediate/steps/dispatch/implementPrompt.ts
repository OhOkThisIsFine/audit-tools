import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import {
  toPromptPathToken,
  severityRank,
  mostCapableTier,
  findingLead,
  renderFindingBadgeBody,
} from "audit-tools/shared";
import { findingNeedsVerificationBeforeFix } from "audit-tools/shared";
import type { RemediationState } from "../../state/store.js";
import type { Finding, ItemSpec, RemediationBlock } from "../../state/types.js";
import {
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
  type DispatchModelHint,
  type DispatchPlanItem,
} from "../types.js";
import { classifyFindingRisk } from "../stepUtils.js";
import { isTerminalStatus } from "../../state/itemStatus.js";
import { runDir, uniquePaths } from "./common.js";
import { buildFreeVerifyCommands } from "./verifyCommands.js";
import { nodeFieldsOf, reconciliationExpectationsOf } from "./dagNodeFields.js";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const WALK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "out",
  ".next", ".turbo", ".audit-tools",
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

/**
 * Collect test files from `index` that reference any of `sourceFiles` by
 * module basename. When `packageRoot` is supplied (repo-relative prefix, e.g.
 * `packages/foo`), only test files under that package are considered —
 * otherwise all test files in the index are matched (existing behavior).
 */
export function collectReferencingTests(
  index: TestFileEntry[],
  sourceFiles: string[],
  packageRoot?: string,
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
  // Normalize packageRoot to forward slashes and ensure it ends without trailing slash
  const pkgPrefix = packageRoot
    ? packageRoot.replace(/\\/g, "/").replace(/\/$/, "") + "/"
    : null;
  const result: string[] = [];
  for (const { rel, content } of index) {
    if (sourceSet.has(rel)) continue;
    // If a package scope is set, skip files outside that package
    if (pkgPrefix && !rel.startsWith(pkgPrefix)) continue;
    if (needles.some((re) => re.test(content))) result.push(rel);
  }
  return result;
}

/**
 * Detect the nearest ancestor directory containing a `package.json` for the
 * first source file in `sourceFiles` (walk up, stop at `root`). Returns the
 * repo-relative path prefix (e.g. `packages/foo`) or undefined if none found.
 */
function detectPackageRoot(sourceFiles: string[], root: string): string | undefined {
  if (sourceFiles.length === 0) return undefined;
  const first = sourceFiles[0];
  // Resolve to absolute path relative to root if not already absolute
  const absFirst = first.startsWith("/") || /^[A-Za-z]:[/\\]/.test(first)
    ? first
    : join(root, first);
  let dir = dirname(absFirst);
  while (dir !== root && dir.length > root.length) {
    if (existsSync(join(dir, "package.json"))) {
      return relative(root, dir).replace(/\\/g, "/");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export { detectPackageRoot };

/**
 * The files an implement worker should receive as context for a finding:
 * pre-document affected_files PLUS any files the document phase declared in the
 * item_spec's `touched_files`.
 */
function itemReadFiles(finding: Finding, spec?: ItemSpec): string[] {
  const files = finding.affected_files.map((f) => f.path);
  if (spec?.touched_files) files.push(...spec.touched_files);
  return uniquePaths(files);
}

/**
 * The files an implement worker is expected to write. The documented
 * `touched_files` set is authoritative when present; affected_files are only a
 * fallback for older or incomplete document results.
 */
function itemWriteFiles(finding: Finding, spec?: ItemSpec): string[] {
  if (Array.isArray(spec?.touched_files)) {
    return uniquePaths(spec.touched_files);
  }
  return uniquePaths(finding.affected_files.map((f) => f.path));
}

/**
 * Repo-relative paths every finding in a block needs for context, deduped.
 */
export function blockReadFiles(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  const files = block.items.flatMap((findingId) => {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) return [];
    return itemReadFiles(finding, state.items?.[findingId]?.item_spec);
  });
  return uniquePaths(files);
}

/**
 * Repo-relative paths every finding in a block may write, deduped. This is kept
 * narrower than read context so a broad affected hub file does not serialize
 * blocks whose documented write sets are actually disjoint.
 */
export function blockWriteFiles(
  block: RemediationBlock,
  state: RemediationState,
): string[] {
  const files = block.items.flatMap((findingId) => {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) return [];
    return itemWriteFiles(finding, state.items?.[findingId]?.item_spec);
  });
  return uniquePaths(files);
}

/**
 * Construct the DispatchPlanItem for an implement task. Single source of truth
 * so prepareImplementDispatch and mergeImplementResults stay in lockstep on item
 * shape.
 */
export function buildImplementDispatchItem(
  block: RemediationBlock,
  state: RemediationState,
  dir: string,
): DispatchPlanItem {
  const taskId = `implement-${block.block_id}`;
  const readFiles = blockReadFiles(block, state);
  const writeFiles = blockWriteFiles(block, state);
  const resultPath = join(dir, `${taskId}.result.json`);
  return {
    task_id: taskId,
    block_id: block.block_id,
    prompt_path: join(dir, `${taskId}.md`),
    result_path: resultPath,
    model_hint: buildImplementModelHint(block, state),
    access: {
      read_paths: readFiles,
      write_paths: [...writeFiles, resultPath],
    },
  };
}

/**
 * Absolute path to a block's implement worker result file for a run. Single
 * source (same convention as {@link buildImplementDispatchItem}'s `result_path`)
 * shared with triage's already-satisfied reconciliation guard: a passing tree
 * verify only proves a node's work was DONE if a worker actually ran and left a
 * result — no result file ⇒ "no worker ran", not "verified satisfied".
 */
export function implementResultPath(
  artifactsDir: string,
  runId: string,
  blockId: string,
): string {
  return join(runDir(artifactsDir, runId, "implement"), `implement-${blockId}.result.json`);
}

export function buildImplementModelHint(
  block: RemediationBlock,
  state: RemediationState,
): DispatchModelHint {
  // Prefer the node's own promoted `model_tier` (derived from contract-pipeline
  // complexity signals) over a re-derived block heuristic. In the contract
  // pipeline a block maps 1:1 to a DAG node, so the block's single finding
  // carries the authoritative relative rank. Never collapse to a flat
  // "standard" when the node declared a tier.
  const nodeTiers = block.items
    .map((findingId) => {
      const finding = state.plan?.findings.find((f) => f.id === findingId);
      return finding ? nodeFieldsOf(finding).model_tier : undefined;
    })
    .filter((t): t is "small" | "standard" | "deep" => t !== undefined);
  if (nodeTiers.length > 0) {
    // Take the most-capable declared rank across the block's nodes so a deep
    // node is never under-provisioned by a sibling's smaller rank. Ordering is
    // the single shared tier-rank authority (`mostCapableTier`).
    const tier = mostCapableTier(nodeTiers) ?? "standard";
    return { tier, reasons: ["node_model_tier"] };
  }

  const deepReasons: string[] = [];
  let allSafe = true;
  let maxSeverityRank = 0;

  for (const findingId of block.items) {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    const rank = severityRank(finding.severity);
    if (rank > maxSeverityRank) maxSeverityRank = rank;
    if (item?.item_spec) {
      const { tier } = classifyFindingRisk(
        finding,
        item.item_spec as import("../../state/types.js").ItemSpec,
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

/**
 * G1 + INV-GND-02: a finding that the auditor's grounding pass marked ungrounded
 * — or that carries NO grounding verdict (undefined → treated as ungrounded) —
 * has not been positively re-verified against the cited code. Instruct the
 * worker to VERIFY the claim against the source first and only then fix it (or
 * resolve_no_change if the claim does not hold), rather than blindly applying a
 * fix to a possibly-stale/hallucinated finding. A positively-grounded finding
 * adds no bullet (it was already re-verified at ingest).
 */
function groundingVerificationBullet(finding: Finding): string {
  if (!findingNeedsVerificationBeforeFix(finding)) return "";
  const reason = finding.grounding?.reason
    ? ` (${finding.grounding.reason})`
    : " (no grounding verdict was recorded for this finding)";
  return `- VERIFY BEFORE FIX: this finding is not positively grounded${reason}. Confirm the claim against the cited code first; if it holds, fix it, otherwise mark the item \`resolved_no_change\` with evidence. Do not apply a fix to an unverified claim.`;
}

/**
 * Opt-in meta-audit reflection invitation (parity with audit-code's worker
 * prompt). Rendered after the file-access section because it carves out one
 * extra append-only path. Shape: the shared `AgentReflectionSchema`;
 * the close phase aggregates the file into the report's "Process Feedback"
 * section. Best-effort by design — it must never compete with the obligation.
 */
function reflectionInvitation(
  feedbackDisplay: string,
  taskId: string,
  lens?: string,
): string {
  return `
## Optional process feedback

Never let this delay or replace the required output above: if you hit task
ambiguity, tool friction, or unclear instructions, you MAY append one JSON
reflection line to \`${feedbackDisplay}\` with shape:
  {"task_id": "${taskId}"${lens ? `, "lens": "${lens}"` : ""}, "instruction_clarity": "clear|mostly_clear|ambiguous|unclear",
   "ambiguities": ["..."], "tool_friction": ["..."], "suggestions": ["..."],
   "severity": "info|low|medium|high"}
One object per line; never overwrite existing lines. Appending to this file is
allowed in addition to the file access above.
`;
}

// ---------------------------------------------------------------------------
// Infra-modifying block detection
// ---------------------------------------------------------------------------

/**
 * The live dispatch/orchestration modules whose modification can break the
 * running engine mid-run. Derived from the REAL post-A12 source layout
 * (`src/remediate/...`) — this module IS one of them (`steps/dispatch.ts`), so
 * the list is anchored to the actual files on disk, not a hand-typed monorepo
 * path that drifts when the tree is reorganised (the pre-A12
 * `packages/remediate-code/...` list silently matched NOTHING after the
 * collapse, so every infra block rendered as non-infra). Each entry is the
 * module's path relative to the `src/remediate` area, forward-slash form.
 */
const INFRA_MODULE_SUBPATHS = [
  "steps/nextStep.ts",
  "steps/dispatch.ts",
  "state/store.ts",
  "steps/contractPipeline.ts",
  "steps/stepWriter.ts",
] as const;

/**
 * The infra module sub-paths anchored under `src/remediate/` — the canonical
 * repo-relative form for the current (post-A12) single-package layout. A write
 * path matches when its normalised (forward-slash) form ends with one of these
 * segments, so an absolute worktree path
 * (`.../worktrees/foo/src/remediate/steps/dispatch.ts`), a repo-relative path
 * (`src/remediate/steps/dispatch.ts`), or a Windows backslash path all match,
 * while a same-basename file in another area (`src/audit/steps/dispatch.ts`)
 * does not.
 */
const INFRA_FILE_SEGMENTS: readonly string[] = INFRA_MODULE_SUBPATHS.map(
  (sub) => `src/remediate/${sub}`,
);

/**
 * Returns true when any path in `writePaths` is one of the live infra modules.
 * Paths are normalised to forward-slash form (win32 backslash → `/`) and matched
 * by trailing repo-relative segment so absolute/worktree/relative spellings all
 * resolve identically. Used to gate the live-surface verification section in the
 * implement prompt.
 */
export function isInfraModifyingBlock(writePaths: string[]): boolean {
  for (const p of writePaths) {
    const normalized = p.replace(/\\/g, "/");
    for (const segment of INFRA_FILE_SEGMENTS) {
      if (normalized === segment || normalized.endsWith("/" + segment)) {
        return true;
      }
    }
  }
  return false;
}

function infraModifyingSection(repoRoot: string): string {
  const rootDisplay = toPromptPathToken(repoRoot);
  return `
## Infra-modifying block

This block modifies the dispatch/orchestration engine that the current run
executes. **The host builds the package centrally — do NOT run \`npm run build\`
or \`npm test\` here** (a worker-side build races the central build's \`dist/\`).
Verify build-free only and let the host re-exercise the live surface after its
central build:

1. **Type-check (no emit):** After completing all edits, run:
   \`\`\`
   npm run check
   \`\`\`
   from \`${rootDisplay}\`. If type-check fails, mark the item blocked and record
   the failure in \`failure_reason\`.

2. **Targeted build-free tests:** Run this package's build-free test runner
   directly against the tests for your change — for remediate-code:
   \`\`\`
   npx vitest run <your-test-file>
   \`\`\`
   from \`${rootDisplay}\`. Never invoke \`npm test\`/\`npm run build\`: those
   prepend a build. If a targeted test fails, mark the item blocked and record
   the failure in \`failure_reason\`.

3. **Rollback is the host's job.** Because you do not build or republish the
   engine, you cannot brick the live dispatcher mid-run. The host owns the
   central build and any dist rollback; record the files you changed in your
   result evidence so the host can attribute a post-build failure.
`;
}

/**
 * Per-item bullets threading what upstream/neighbor nodes agreed to provide
 * (INV-DS-12): the node's reconciliation_expectations / preconditions and its
 * expected_changes. Rendered inside each item so a dependent node implements
 * against the realized upstream surface rather than guessing.
 */
function upstreamExpectationsBullets(finding: Finding): string {
  const node = nodeFieldsOf(finding);
  const expectations = reconciliationExpectationsOf(finding);
  const lines: string[] = [];
  if (expectations.length > 0) {
    lines.push(
      `- Upstream/neighbor contract provides (implement against these, do not redefine them): ${expectations.join("; ")}`,
    );
  }
  if (typeof node.expected_changes === "string" && node.expected_changes.trim().length > 0) {
    lines.push(`- Expected changes: ${node.expected_changes.trim()}`);
  }
  if (Array.isArray(node.verification) && node.verification.length > 0) {
    lines.push(`- Verification checks: ${node.verification.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * The build-free per-node verification section. Emits the node's own build-free
 * targeted commands (build/build-prepending commands filtered out — residual
 * CE-001) plus the standard build-free baseline (`npm run check` + the package's
 * build-free test runner). NON-EMITTING: it instructs the worker to run these to
 * gate its own result, never to emit further dispatch.
 */
function perNodeVerificationSection(
  block: RemediationBlock,
  state: RemediationState,
  rootDisplay: string,
): string {
  const nodeCommands = uniquePaths(
    block.items.flatMap((findingId) => {
      const finding = state.plan?.findings.find((f) => f.id === findingId);
      return finding ? buildFreeVerifyCommands(finding.targeted_commands) : [];
    }),
  );
  const commandBlock =
    nodeCommands.length > 0
      ? `Run these node-targeted, build-free commands and record each command + result in the affected item's evidence:
\`\`\`
${nodeCommands.join("\n")}
\`\`\`
`
      : "";
  return `
## Per-node verification (build-free)

The host builds the package centrally; do NOT run \`npm run build\` or \`npm test\`
(either races the central build's \`dist/\`). Verify build-free only, from
\`${rootDisplay}\`:

- Type-check with \`npm run check\` (no emit).
- Run the package's build-free test runner directly against your change
  (remediate-code: \`npx vitest run <your-test-file>\`; node-test packages:
  \`node --import tsx/esm --test <your-test-file>\`).

${commandBlock}A node is verified-complete only when its declared outputs exist and these
build-free checks pass; otherwise mark the item blocked with the failure in
\`failure_reason\`.
`;
}

export function implementPrompt(
  block: RemediationBlock,
  state: RemediationState,
  resultPath: string,
  conventions: string,
  repoRoot: string,
  feedbackDisplay: string,
  worktreeRoot?: string,
): string {
  const items = block.items.flatMap((findingId) => {
    const item = state.items?.[findingId];
    const finding = state.plan?.findings.find((entry) => entry.id === findingId);
    if (!finding) return [];
    // Only render items that still need implementing — never a resolved item
    // from a prior wave or one the user skipped (deemed_inappropriate/ignored).
    if (!item || isTerminalStatus(item.status)) return [];
    if (item.status !== "pending") return [];
    // item_spec may be pre-populated from the plan DAG node or absent;
    // either way the implementer receives finding context directly.
    // clarification_context carries the user's answer when this item was re-opened
    // from a clarification round (up-front gate or mid-run) — thread it through so
    // the retry acts on the decided scope, not the original ambiguity.
    return [{ finding, spec: item.item_spec, clarification: item.clarification_context }];
  });

  // When a worktreeRoot is supplied, the worker operates in the worktree, not
  // the main repo root. Source file paths are prefixed with the worktree root.
  // The result path always lives in the artifacts dir (outside the worktree).
  const effectiveRoot = worktreeRoot ?? repoRoot;
  // Normalize to forward slashes for host-facing prompt text; bash-like shells
  // on Windows treat backslashes as escape characters.
  const rootDisplay = toPromptPathToken(effectiveRoot);
  const resultDisplay = toPromptPathToken(resultPath);

  // Prefix each source file path with the worktree root when applicable.
  function resolveFilePath(rel: string): string {
    if (!worktreeRoot) return rel;
    if (rel.startsWith("/") || /^[A-Za-z]:[/\\]/.test(rel)) return rel;
    return toPromptPathToken(join(worktreeRoot, rel));
  }

  const worktreeNote = worktreeRoot
    ? `\nYou are working in a worktree at ${toPromptPathToken(worktreeRoot)}; all file edits go here. Do not edit files outside this worktree.\n`
    : "";

  return `
# Implement Remediation Block

You are implementing one bounded remediation block. Edit the files needed for the
findings in this prompt, and you MAY create new files (e.g. a test file or an
extracted module) within the SAME package as those files when a finding's change
calls for it. Do not edit unrelated files in other packages, and do not change
remediation state files directly.
Repository root: ${rootDisplay}
Set the shell/tool workdir to the repository root when running commands; do not rely on cwd state from prior shell calls.

## Block

- Block ID: ${block.block_id}
- Findings: ${items.map(({ finding }) => finding.id).join(", ")}

## Items

${items
  .map(
    ({ finding, spec, clarification }) => `
### ${finding.id} — ${finding.title}

${findingLead(finding.summary)}

${renderFindingBadgeBody(finding, { showGrounding: false, showAdvisoryMeta: false, showFiles: false, showDetails: false, showEvidence: false }).join("\n")}
- Files: ${itemReadFiles(finding, spec).map(resolveFilePath).join(", ")}
- Details: ${finding.summary}
${clarification ? `- Clarified scope (decided with the user — act on THIS): ${clarification}\n` : ""}${groundingVerificationBullet(finding)}
${spec ? `- Concrete change: ${spec.concrete_change}
- Tests to write: ${spec.tests_to_write
      .map((test) => `${test.name}: ${test.assertions.join("; ")}`)
      .join(" | ")}` : ""}
${upstreamExpectationsBullets(finding)}
`,
  )
  .join("\n")}
${conventions ? `\n${conventions}\n` : ""}${perNodeVerificationSection(block, state, rootDisplay)}${isInfraModifyingBlock(blockWriteFiles(block, state)) ? infraModifyingSection(repoRoot) : ""}
## Verification
${worktreeNote}
Run changed or newly created tests by name when possible, and record the focused
command and result in the affected item's evidence. If a broad or full-suite
command fails in a dirty worktree and appears unrelated or pre-existing, record
that broad failure separately instead of using it as the only verdict for this
block. If a focused test for this block fails, the affected item remains blocked.
If targeted commands are listed under an item, run them when applicable and
include each command and result in that item's evidence.

Windows PowerShell: do not pipe an inline foreach statement directly into ConvertTo-Json.
Assign the foreach output to a variable first, then pipe that variable to ConvertTo-Json.

## Output

After editing and verifying the block, write JSON to exactly:

\`${resultDisplay}\`

Emit **exactly one \`item_results\` entry per node id below — no more, no fewer**.
Each entry's \`finding_id\` MUST be one of the exact ids: ${items
    .map(({ finding }) => `\`${finding.id}\``)
    .join(", ")}. Do not substitute a title, an obligation id, or a block id for
the node id, and do not emit duplicate entries for the same node.

\`\`\`json
{
  "contract_version": "${REMEDIATION_WORKER_RESULT_CONTRACT_VERSION}",
  "phase": "implement",
  "item_results": [
${items
    .map(
      ({ finding }) => `    {
      "finding_id": "${finding.id}",
      "status": "resolved",
      "evidence": ["test or verification evidence"]
    }`,
    )
    .join(",\n")}
  ]
}
\`\`\`

For an item you cannot safely finish because of an EXECUTION failure (a test
won't pass, a build breaks, the change is infeasible), set \`status\` to
\`blocked\` and include \`failure_reason\`. If instead you are stuck on a SCOPING
or JUDGMENT question — how far the fix should reach, which of several valid
behaviors is intended, or whether the issue is real — do NOT guess and do NOT
block: set \`status\` to \`needs_clarification\` and put the question in
\`clarification_question\` (optionally \`clarification_category\`). It is routed to
the user as a real question, then re-dispatched with the answer. Stop after
writing the result JSON.

## File access

Read: ${uniquePaths(items.flatMap(({ finding, spec }) => itemReadFiles(finding, spec))).join(", ")}
Write: ${uniquePaths(items.flatMap(({ finding, spec }) => itemWriteFiles(finding, spec))).join(", ")}
You may also create new files within the same package as those files (e.g. tests
or extracted modules) when a finding requires it.
If your change renames, moves, or removes a symbol, also update the existing test
files that reference it — fixing tests for a changed surface is part of this
block, not a later cleanup. Test files that reference these files are included in
your write access.
Write result: ${resultDisplay}
Do not modify unrelated files outside these paths or files in other packages.
${reflectionInvitation(feedbackDisplay, block.block_id)}`;
}
