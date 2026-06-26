import { RemediationState } from "../state/store.js";
import { OrchestratorOptions } from "../types/options.js";
import {
  RemediationPlan,
  Finding,
  RemediationBlock,
  RemediationItemState,
  CoverageLedger,
  CoverageLedgerEntry,
} from "../state/types.js";
import { writeFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AuditFindingsReport, FindingTheme, IntentCheckpoint } from "audit-tools/shared";
import {
  isValidAuditFindingsReport,
  findingNeedsVerificationBeforeFix,
  interpretFreeFormIntent,
} from "audit-tools/shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { snapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  groundExtractedFindings,
  type ExtractedFindingGrounding,
} from "./grounding.js";
import {
  readOptionalJsonFile,
  writeJsonFile,
  readJsonFile,
  formatValidationIssues,
  discoverProjectCommands,
  resolveContextBudget,
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  type SessionConfig,
} from "audit-tools/shared";
import { createFreshSessionProvider } from "../providers/index.js";
import { canonicalizeFilePath } from "../dispatch/ownershipRegistry.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import { filterFindingsByCheckpoint } from "../intent/checkpointFilter.js";
import { applyIntentOrdering } from "../intent/intentOrdering.js";
import {
  validateRemediationPlan,
  validateFinding,
} from "../validation/remediationState.js";
import { runCommand } from "../utils/commands.js";
import {
  createLaunchInputForTask,
  createRemediationWorkerTask,
} from "./workerTasks.js";

function enumerateTestFiles(root: string): string[] {
  if (!existsSync(join(root, "package.json"))) {
    return [];
  }

  // Try vitest first, then jest, and return the list of test file paths
  const vitestResult = runCommand(
    "npx",
    ["vitest", "--reporter=verbose", "--run", "--passWithNoTests", "list"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (vitestResult.status === 0 && vitestResult.stdout) {
    const files = vitestResult.stdout
      .toString()
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(
        (l: string) =>
          l.length > 0 &&
          !l.startsWith("✓") &&
          !l.startsWith("×") &&
          l.includes("."),
      );
    if (files.length > 0) return files;
  }

  const jestResult = runCommand(
    "npx",
    ["jest", "--listTests", "--no-coverage"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (jestResult.status === 0 && jestResult.stdout) {
    const files = jestResult.stdout
      .toString()
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);
    if (files.length > 0) return files;
  }

  return [];
}

/**
 * Parse the auditor's canonical `audit-findings.json` (the machine contract) into
 * remediation findings, work blocks, and synthesis themes. The auditor emits this
 * directly (Phase 6); the remediator consumes it verbatim, so there is no markdown
 * parsing — non-auditor input still flows through the free-form LLM extractor.
 */
export function parseAuditFindingsReport(report: AuditFindingsReport): {
  findings: Finding[];
  blocks: RemediationBlock[];
  themes: FindingTheme[];
} {
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const blocks: RemediationBlock[] = Array.isArray(report.work_blocks)
    ? report.work_blocks.map((block) => ({
        block_id: block.id,
        items: [...(block.finding_ids ?? [])],
        dependencies: [...(block.depends_on ?? [])],
        parallel_safe: (block.depends_on?.length ?? 0) === 0,
        // touched_files is REQUIRED on the block contract; the meaningful
        // surface is derived downstream (mergeBlocksSharingFiles / M1-DECOMPOSE)
        // from the block's findings — seed it empty here.
        touched_files: [],
      }))
    : [];
  const themes = Array.isArray(report.themes) ? report.themes : [];
  return { findings, blocks, themes };
}

/**
 * Whether a parsed JSON value is a valid audit-findings report.
 *
 * INV-remediate-state-07: delegates to the shared validator which enforces
 * contract_version presence and expected value. An absent or mismatched
 * contract_version is rejected here rather than silently trusted.
 */
export function isAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  return isValidAuditFindingsReport(value);
}

/** Parse JSON content into an audit-findings report, or undefined if it is not one. */
function tryParseFindingsReport(
  content: string,
): AuditFindingsReport | undefined {
  try {
    const parsed = JSON.parse(content);
    return isAuditFindingsReport(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface PlanPhaseDeps {
  enumerateTestFiles?: (root: string) => string[];
  runCommand?: typeof runCommand;
  now?: () => number;
  /** Test seam: replaces the provider-backed free-form extraction worker. */
  extractFindings?: (
    content: string,
    options: OrchestratorOptions,
  ) => Promise<{ findings: Finding[]; blocks: RemediationBlock[] }>;
  /** Test seam: replaces the provider-backed bounded path-repair worker. */
  repairExtractedFindingPaths?: (
    requests: { finding: Finding; phantomPaths: string[] }[],
  ) => Promise<Map<string, string[]>>;
}

function createBlockId(counter: number): string {
  return `B-${String(counter).padStart(3, "0")}`;
}

function assignFindingToBlock(
  finding: Finding,
  blockId: string,
  blocks: RemediationBlock[],
  fileToBlock: Map<string, string>,
): void {
  let block = blocks.find((candidate) => candidate.block_id === blockId);
  if (!block) {
    block = { block_id: blockId, items: [], parallel_safe: true, touched_files: [] };
    blocks.push(block);
  }
  block.items.push(finding.id);
  for (const file of finding.affected_files) {
    fileToBlock.set(file.path, blockId);
  }
}

export function deriveBlocksFromTestGraph(
  findings: Finding[],
  testFiles: string[],
): { blocks: RemediationBlock[]; useful: boolean } {
  const blocks: RemediationBlock[] = [];
  const fileToBlock = new Map<string, string>();
  let blockCounter = 1;

  const sourceToTests = new Map<string, Set<string>>();
  for (const finding of findings) {
    for (const af of finding.affected_files) {
      if (!sourceToTests.has(af.path)) {
        const sourceParts = af.path.split(/[/\\]/).filter(Boolean);
        const covering = testFiles.filter((tf) => {
          const testParts = tf.split(/[/\\]/).filter(Boolean);
          return sourceParts.some((part) => testParts.includes(part));
        });
        sourceToTests.set(af.path, new Set(covering));
      }
    }
  }

  for (const finding of findings) {
    let assignedBlock: string | null = null;

    for (const af of finding.affected_files) {
      if (fileToBlock.has(af.path)) {
        assignedBlock = fileToBlock.get(af.path)!;
        break;
      }
      const testsA = sourceToTests.get(af.path) ?? new Set<string>();
      for (const [existingFile, existingBlock] of fileToBlock.entries()) {
        const testsB = sourceToTests.get(existingFile) ?? new Set<string>();
        const shared = [...testsA].filter((t) => testsB.has(t));
        if (shared.length > 0) {
          assignedBlock = existingBlock;
          break;
        }
      }
      if (assignedBlock) break;
    }

    if (!assignedBlock) {
      assignedBlock = createBlockId(blockCounter++);
    }
    assignFindingToBlock(finding, assignedBlock, blocks, fileToBlock);
  }

  return {
    blocks,
    useful: blocks.length < findings.length,
  };
}

function collectFileCommits(
  findings: Finding[],
  root: string,
  commandRunner: typeof runCommand,
): Map<string, Set<string>> {
  const fileCommits = new Map<string, Set<string>>();
  for (const finding of findings) {
    for (const file of finding.affected_files) {
      if (fileCommits.has(file.path)) continue;
      try {
        const result = commandRunner(
          "git",
          ["log", "--format=%H", "--", file.path],
          { cwd: root, encoding: "utf8" },
        );
        fileCommits.set(
          file.path,
          result.status === 0 && result.stdout
            ? new Set(
                result.stdout
                  .toString()
                  .split("\n")
                  .map((s: string) => s.trim())
                  .filter((s: string) => s.length > 0),
              )
            : new Set(),
        );
      } catch {
        fileCommits.set(file.path, new Set());
      }
    }
  }
  return fileCommits;
}

function deriveBlocksFromGitCocommit(
  findings: Finding[],
  fileCommits: Map<string, Set<string>>,
): RemediationBlock[] {
  const blocks: RemediationBlock[] = [];
  const fileToBlock = new Map<string, string>();
  let blockCounter = 1;

  for (const finding of findings) {
    let assignedBlock: string | null = null;

    for (const file of finding.affected_files) {
      if (fileToBlock.has(file.path)) {
        assignedBlock = fileToBlock.get(file.path)!;
        break;
      }
      const commitsA = fileCommits.get(file.path) ?? new Set<string>();
      for (const [existingFile, existingBlock] of fileToBlock.entries()) {
        const commitsB = fileCommits.get(existingFile) ?? new Set<string>();
        let intersection = 0;
        for (const c of commitsA) if (commitsB.has(c)) intersection++;
        const union = commitsA.size + commitsB.size - intersection;
        if (union > 0 && intersection / union > 0.5) {
          assignedBlock = existingBlock;
          break;
        }
      }
      if (assignedBlock) break;
    }

    if (!assignedBlock) {
      assignedBlock = createBlockId(blockCounter++);
    }
    assignFindingToBlock(finding, assignedBlock, blocks, fileToBlock);
  }

  return blocks;
}

// Block-sizing constants: now single-sourced from audit-tools/shared.
// Re-exported under their legacy names so any callers outside this package
// (and dispatch.ts) can migrate to the shared constants at their own pace.
export {
  ESTIMATED_PROMPT_OVERHEAD_TOKENS as ESTIMATED_BLOCK_BASE_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS as ESTIMATED_FINDING_OVERHEAD_TOKENS,
} from "audit-tools/shared";

function resolveContextBudgetFromConfig(sessionConfig: SessionConfig | null): number {
  const quota = sessionConfig?.block_quota ?? {};
  return resolveContextBudget({
    contextTokens: quota.context_tokens ?? null,
    reservedOutputTokens: quota.reserved_output_tokens ?? null,
  });
}

const PLAN_WALK_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "out", ".audit-tools",
]);

function walkDirBytes(dir: string, maxFiles = 200): number {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0 && count < maxFiles) {
    const cur = stack.pop()!;
    try {
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        if (PLAN_WALK_SKIP_DIRS.has(entry.name)) continue;
        const full = join(cur, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          count++;
          try {
            total += statSync(full).size;
          } catch {
            // ignore unreadable files
          }
          if (count >= maxFiles) break;
        }
      }
    } catch {
      continue;
    }
  }
  return total;
}

function isDirectoryPath(filePath: string, root: string): boolean {
  const fullPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  try {
    return statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

// Phase 2: size by bytes from a stat (no full-file reads) rather than counting
// lines, and convert to tokens via the shared estimator.
function fileSizeBytes(filePath: string, root: string): number {
  const fullPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  try {
    const st = statSync(fullPath);
    return st.isDirectory() ? walkDirBytes(fullPath) : st.size;
  } catch {
    return 0;
  }
}

function groupFindingsByFileOverlap(findingIds: string[], findings: Finding[], repoRoot = "."): string[][] {
  const parent = new Map<string, string>(findingIds.map((id) => [id, id]));

  function find(id: string): string {
    let cur = id;
    while (parent.get(cur) !== cur) {
      const grandparent = parent.get(parent.get(cur)!)!;
      parent.set(cur, grandparent);
      cur = grandparent;
    }
    return cur;
  }

  const findingMap = new Map(findings.map((f) => [f.id, f]));
  const fileToIds = new Map<string, string[]>();

  for (const id of findingIds) {
    for (const af of findingMap.get(id)?.affected_files ?? []) {
      // Directory paths must not drive union-find merges: a broad directory shared
      // by many findings would otherwise collapse them all into one indivisible block.
      if (isDirectoryPath(af.path, repoRoot)) continue;
      // CE-008: key the overlap map by the M1-BOUNDARY canonical physical-file
      // identity, not the raw spelling, so `src/A.ts`, `./src/A.ts`, `src\A.ts`
      // (and case variants on a case-insensitive FS) collide on ONE key and the
      // findings that touch that file are unioned into one block. Comparing raw
      // strings would leave them in separate blocks that then write the same
      // physical file in parallel (the clobber CE-008 closes).
      const key = canonicalizeFilePath(af.path, { root: repoRoot });
      const list = fileToIds.get(key) ?? [];
      list.push(id);
      fileToIds.set(key, list);
    }
  }

  for (const ids of fileToIds.values()) {
    for (let i = 1; i < ids.length; i++) {
      const ra = find(ids[0]);
      const rb = find(ids[i]);
      if (ra !== rb) parent.set(ra, rb);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of findingIds) {
    const repr = find(id);
    const g = groups.get(repr) ?? [];
    g.push(id);
    groups.set(repr, g);
  }
  return [...groups.values()];
}

export function estimateGroupTokens(
  findingIds: string[],
  findings: Finding[],
  fileByteCounts: Map<string, number>,
  // CE-008: when `root` is supplied, file keys are resolved to the M1-BOUNDARY
  // canonical physical-file identity so a file cited under two spellings is
  // de-duplicated to ONE entry and resolves to the byte-count map keyed the same
  // way. When omitted, raw spellings are used as keys (callers that pre-key the
  // byte-count map by raw path keep working unchanged).
  root?: string,
): number {
  const fileKey = (p: string): string =>
    root === undefined ? p : canonicalizeFilePath(p, { root });
  const uniqueFiles = new Set<string>();
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const id of findingIds) {
    for (const af of findingMap.get(id)?.affected_files ?? [])
      uniqueFiles.add(fileKey(af.path));
  }
  const totalBytes = [...uniqueFiles].reduce((sum, p) => sum + (fileByteCounts.get(p) ?? 0), 0);
  return (
    ESTIMATED_PROMPT_OVERHEAD_TOKENS +
    estimateTokensFromBytes(totalBytes) +
    findingIds.length * ESTIMATED_ITEM_OVERHEAD_TOKENS
  );
}

function splitOversizedOverlapGroup(
  group: string[],
  findings: Finding[],
  fileByteCounts: Map<string, number>,
  contextBudget: number,
  root?: string,
): string[][] {
  if (
    group.length <= 1 ||
    estimateGroupTokens(group, findings, fileByteCounts, root) <= contextBudget
  ) {
    return [group];
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const findingId of group) {
    const candidate = [...current, findingId];
    if (
      current.length > 0 &&
      estimateGroupTokens(candidate, findings, fileByteCounts, root) > contextBudget
    ) {
      chunks.push(current);
      current = [findingId];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function splitBlocksByContextBudget(
  blocks: RemediationBlock[],
  findings: Finding[],
  root: string,
  contextBudget: number,
): RemediationBlock[] {
  // CE-008: index byte counts by the M1-BOUNDARY canonical physical-file identity
  // so the same file cited under two spellings is sized ONCE (not double-counted)
  // and `estimateGroupTokens` resolves every spelling to the same entry.
  const allFiles = new Map<string, string>(); // canonical key -> a raw spelling to stat
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const block of blocks) {
    for (const id of block.items) {
      for (const af of findingMap.get(id)?.affected_files ?? []) {
        const key = canonicalizeFilePath(af.path, { root });
        if (!allFiles.has(key)) allFiles.set(key, af.path);
      }
    }
  }

  const fileByteCounts = new Map<string, number>();
  for (const [key, rawPath] of allFiles) {
    fileByteCounts.set(key, fileSizeBytes(rawPath, root));
  }

  const result: RemediationBlock[] = [];
  // Maps an original block_id to the sub-block IDs it was expanded into.
  // Used in the second pass to rewrite dependency references in other blocks.
  const splitRemap = new Map<string, string[]>();

  for (const block of blocks) {
    const fileGroups = groupFindingsByFileOverlap(block.items, findings, root);

    const subBlocks: string[][] = [];
    let currentItems: string[] = [];
    let currentTokens = 0;

    for (const overlapGroup of fileGroups) {
      const groups = splitOversizedOverlapGroup(
        overlapGroup,
        findings,
        fileByteCounts,
        contextBudget,
        root,
      );
      for (const group of groups) {
        const groupTokens = estimateGroupTokens(group, findings, fileByteCounts, root);
        if (currentItems.length > 0 && currentTokens + groupTokens > contextBudget) {
          subBlocks.push(currentItems);
          currentItems = group;
          currentTokens = groupTokens;
        } else {
          currentItems = [...currentItems, ...group];
          currentTokens += groupTokens;
        }
      }
    }
    if (currentItems.length > 0) subBlocks.push(currentItems);

    if (subBlocks.length === 1) {
      result.push(block);
    } else {
      const subBlockIds = subBlocks.map(
        (_, i) => `${block.block_id}-${String(i + 1).padStart(2, "0")}`,
      );
      splitRemap.set(block.block_id, subBlockIds);
      for (let i = 0; i < subBlocks.length; i++) {
        result.push({
          block_id: subBlockIds[i]!,
          items: subBlocks[i],
          parallel_safe: block.parallel_safe,
          dependencies: block.dependencies,
          // Sub-blocks inherit the parent's declared surface; the per-sub-block
          // narrowing is a downstream (M1-DECOMPOSE) concern.
          touched_files: [...(block.touched_files ?? [])],
        });
      }
    }
  }

  // Second pass: rewrite dependency references in result blocks so that a block
  // depending on a split block now depends on ALL the resulting sub-blocks.
  if (splitRemap.size > 0) {
    for (const block of result) {
      if (!block.dependencies || block.dependencies.length === 0) continue;
      const rewritten = [
        ...new Set(
          block.dependencies.flatMap((dep) => splitRemap.get(dep) ?? [dep]),
        ),
      ];
      block.dependencies = rewritten;
    }
  }

  return result;
}

function deriveFallbackBlocks(
  findings: Finding[],
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): {
  blocks: RemediationBlock[];
  blockStrategy?: RemediationPlan["block_strategy"];
} {
  if (findings.length === 0) return { blocks: [] };

  const testFiles =
    deps.enumerateTestFiles?.(options.root) ?? enumerateTestFiles(options.root);
  if (testFiles.length > 0) {
    const testGraph = deriveBlocksFromTestGraph(findings, testFiles);
    if (testGraph.useful) {
      return { blocks: testGraph.blocks, blockStrategy: "test_graph" };
    }
  }

  const fileCommits = collectFileCommits(
    findings,
    options.root,
    deps.runCommand ?? runCommand,
  );
  const gitBlocks = deriveBlocksFromGitCocommit(findings, fileCommits);
  if (gitBlocks.some((b) => b.items.length > 1)) {
    return { blocks: gitBlocks, blockStrategy: "git_cocommit" };
  }

  return {
    blocks: findings.map((finding, index) => ({
      block_id: createBlockId(index + 1),
      items: [finding.id],
      parallel_safe: true,
      // One finding per block — declare its affected files as the block surface.
      touched_files: finding.affected_files.map((af) => af.path),
    })),
    blockStrategy: "file_overlap",
  };
}

/**
 * Account for every finding the plan received: each is marked `planned` (kept and
 * mapped to a block), `folded_into` (merged into a survivor by cross-lens dedup),
 * `dropped_no_evidence` (excluded for carrying no evidence), `dropped_by_checkpoint`,
 * or `dropped_phantom_paths` (every cited path was phantom, post-repair). The
 * dispositions are mutually exclusive and cover the whole source set, so nothing
 * is lost silently. Kept extracted findings additionally carry their grounding
 * annotations (stripped phantom paths, evidence-grounded flag).
 */
export function buildCoverageLedger(params: {
  planId: string;
  sourceFindings: Finding[];
  droppedNoEvidence: string[];
  droppedByCheckpoint: string[];
  /** Findings dropped by the grounding pass, with the phantom paths they cited. */
  droppedPhantomPaths?: Map<string, string[]>;
  /** Phantom paths stripped from findings that survived grounding. */
  phantomPathsRemoved?: Map<string, string[]>;
  /**
   * Findings the user disapproved at the review-approval gate, with the recorded
   * reason. These are IN `sourceFindings` (an approved/declined finding is a
   * filter-pass survivor — folded/dropped findings never reach the gate), so they
   * produce an in-source `declined_by_review` disposition exactly like
   * `droppedByCheckpoint`, and they ARE part of the source reconciliation.
   */
  declinedByReview?: Array<{ finding_id: string; reason: string }>;
  mergeMap: Map<string, string>;
  items: Record<string, RemediationItemState>;
}): CoverageLedger {
  const dropped = new Set(params.droppedNoEvidence);
  const byCheckpoint = new Set(params.droppedByCheckpoint);
  const declinedReasons = new Map(
    (params.declinedByReview ?? []).map((d) => [d.finding_id, d.reason] as const),
  );
  const groundingAnnotations = (f: Finding): Partial<CoverageLedgerEntry> => {
    const phantoms = params.phantomPathsRemoved?.get(f.id);
    return {
      ...(phantoms && phantoms.length > 0
        ? { phantom_paths_removed: phantoms }
        : {}),
      ...(f.evidence_grounded !== undefined
        ? { evidence_grounded: f.evidence_grounded }
        : {}),
    };
  };
  const entries: CoverageLedgerEntry[] = params.sourceFindings.map((f) => {
    const phantomPaths = params.droppedPhantomPaths?.get(f.id);
    if (phantomPaths) {
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "dropped_phantom_paths",
        rationale:
          "Every cited affected_files path was phantom (does not exist in the repository) and one bounded repair attempt did not produce a real path.",
        phantom_paths_removed: phantomPaths,
      };
    }
    if (dropped.has(f.id)) {
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "dropped_no_evidence",
        rationale: "Finding carried no evidence and was excluded from the plan.",
      };
    }
    const survivor = params.mergeMap.get(f.id);
    if (survivor) {
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "folded_into",
        folded_into: survivor,
        ...groundingAnnotations(f),
      };
    }
    if (byCheckpoint.has(f.id)) {
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "dropped_by_checkpoint",
        rationale:
          "Finding excluded by the intent checkpoint (filter or excluded scope).",
      };
    }
    if (declinedReasons.has(f.id)) {
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "declined_by_review",
        rationale:
          declinedReasons.get(f.id) ??
          "Disapproved by the user at the review-approval gate.",
      };
    }
    return {
      finding_id: f.id,
      title: f.title,
      disposition: "planned",
      block_id: params.items[f.id]?.block_id,
      ...groundingAnnotations(f),
    };
  });
  const count = (d: CoverageLedgerEntry["disposition"]): number =>
    entries.filter((e) => e.disposition === d).length;
  return {
    contract_version: "remediate-code-coverage/v1alpha1",
    plan_id: params.planId,
    source_finding_count: params.sourceFindings.length,
    planned_count: count("planned"),
    folded_count: count("folded_into"),
    dropped_count: count("dropped_no_evidence"),
    checkpoint_dropped_count: count("dropped_by_checkpoint"),
    phantom_dropped_count: count("dropped_phantom_paths"),
    declined_review_count: count("declined_by_review"),
    entries,
  };
}

/**
 * Merge any blocks whose findings touch a shared file, UNLESS an explicit
 * dependency already serializes them (ordered blocks never run in parallel, so a
 * shared file between them is safe). This keeps a finding whose fix-set spans
 * blocks inside a single block and guarantees no two parallel blocks ever write
 * the same file — the documented "several blocks all editing the same file"
 * clobber. Pure; preserves the auditor's structure when nothing overlaps.
 */
export function mergeBlocksSharingFiles(
  blocks: RemediationBlock[],
  findings: Finding[],
  root = ".",
): RemediationBlock[] {
  if (blocks.length < 2) return blocks;
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  const byId = new Map(blocks.map((b) => [b.block_id, b]));

  // CE-008: a block's file set is keyed by the M1-BOUNDARY canonical physical-file
  // identity, so two blocks that cite the same file under different spellings
  // (rel/abs, `./`-prefixed, mixed separators, case on a case-insensitive FS) are
  // detected as sharing it and merged — never left to clobber it in parallel.
  const fileSet = (b: RemediationBlock): Set<string> => {
    const files = new Set<string>();
    for (const id of b.items) {
      for (const af of findingMap.get(id)?.affected_files ?? []) {
        if (!isDirectoryPath(af.path, root)) {
          files.add(canonicalizeFilePath(af.path, { root }));
        }
      }
    }
    return files;
  };

  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(byId.get(from)?.dependencies ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(byId.get(cur)?.dependencies ?? []));
    }
    return false;
  };
  const ordered = (a: string, b: string): boolean =>
    reaches(a, b) || reaches(b, a);

  const parent = blocks.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  const fileSets = blocks.map(fileSet);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (find(i) === find(j)) continue;
      const shareFile = [...fileSets[i]].some((p) => fileSets[j].has(p));
      if (shareFile && !ordered(blocks[i].block_id, blocks[j].block_id)) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < blocks.length; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  if (groups.size === blocks.length) return blocks; // nothing overlapped

  const idRemap = new Map<string, string>();
  const groupList = [...groups.values()];
  for (const idxs of groupList) {
    const ids = idxs.map((i) => blocks[i].block_id).sort();
    const mergedId = ids[0];
    for (const id of ids) idRemap.set(id, mergedId);
  }

  return groupList.map((idxs) => {
    const groupBlocks = idxs.map((i) => blocks[i]);
    const mergedId = idRemap.get(groupBlocks[0].block_id)!;
    const items = [...new Set(groupBlocks.flatMap((b) => b.items))];
    const deps = new Set<string>();
    for (const b of groupBlocks) {
      for (const d of b.dependencies ?? []) {
        const remapped = idRemap.get(d) ?? d;
        if (remapped !== mergedId) deps.add(remapped);
      }
    }
    // A singleton group is unchanged except for dependency remapping — preserve
    // its original parallel_safe rather than recomputing (and possibly flipping)
    // it from deps. Only genuinely merged groups derive parallel_safe afresh.
    const parallel_safe =
      idxs.length === 1 ? groupBlocks[0].parallel_safe : deps.size === 0;
    const touched_files = [
      ...new Set(groupBlocks.flatMap((b) => b.touched_files ?? [])),
    ];
    return {
      block_id: mergedId,
      items,
      parallel_safe,
      touched_files,
      ...(deps.size > 0 ? { dependencies: [...deps] } : {}),
    };
  });
}

/**
 * Applies the three post-dedup pipeline steps that every plan must go through
 * before being handed off to the implement phase:
 *
 *   1. mergeBlocksSharingFiles  — prevents parallel workers clobbering the same file
 *   2. splitBlocksByContextBudget — keeps each block within the agent context window
 *   3. snapshotAffectedFileHashes — records baseline hashes for integrity checks
 *
 * Extracted so that both runPlanPhase (fast-path JSON reports) and
 * handlePendingExtractedPlan (LLM-extracted plans) run identical post-dedup
 * logic and the two paths cannot drift apart.
 */
export async function applyPlanPipeline(
  plan: RemediationPlan,
  options: { root: string; artifactsDir?: string },
): Promise<RemediationPlan> {
  const { findings } = plan;
  let { blocks } = plan;

  // Merge blocks whose findings touch a shared file.
  blocks = mergeBlocksSharingFiles(blocks, findings, options.root);

  // Split blocks that would exceed the implementation agent's context budget.
  const sessionConfig = await readOptionalJsonFile<SessionConfig>(
    join(options.root, "session-config.json"),
  );
  const contextBudget = resolveContextBudgetFromConfig(sessionConfig ?? null);
  blocks = splitBlocksByContextBudget(blocks, findings, options.root, contextBudget);

  // Record baseline file hashes for the integrity check that runs before dispatch.
  snapshotAffectedFileHashes(options.root, findings);

  return { ...plan, blocks };
}

/**
 * Prune blocks so that every item reference is still in the kept-findings set,
 * and drop blocks whose item list becomes empty after pruning.
 * Used in runPlanPhase wherever a reduction step drops some findings.
 * Extracted to eliminate the three formerly-duplicated inline occurrences of
 * blocks.map(b => ({...b, items: b.items.filter(id => keptIds.has(id))})).filter(...)
 */
export function pruneBlocksForKeptFindings(
  blocks: RemediationBlock[],
  keptFindings: Finding[],
): RemediationBlock[] {
  const keptIds = new Set(keptFindings.map((f) => f.id));
  return blocks
    .map((b) => ({ ...b, items: (b.items ?? []).filter((id) => keptIds.has(id)) }))
    .filter((b) => (b.items ?? []).length > 0);
}

export async function runPlanPhase(
  state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps = {},
): Promise<RemediationState> {
  console.log("Running Plan Phase...");

  let findings: Finding[] = [];
  let blocks: RemediationBlock[] = [];
  let themes: FindingTheme[] = [];
  let extractedFromProse = false;

  if (options.input && existsSync(options.input)) {
    const content = await readFile(options.input, "utf8");
    // Canonical hand-off: the auditor's audit-findings.json (the machine
    // contract). Parsed directly; any other input is free-form and flows
    // through the LLM extractor.
    const findingsReport = tryParseFindingsReport(content);
    if (findingsReport) {
      console.log(`Consuming audit-findings report: ${options.input}`);
      const parsed = parseAuditFindingsReport(findingsReport);
      findings = parsed.findings;
      blocks = parsed.blocks;
      themes = parsed.themes;
      // G1 + INV-GND-02: the auditor's grounding pass (S7) marks each finding
      // grounded or ungrounded; a finding with NO grounding verdict is treated
      // as ungrounded (verify-before-fix), never silently trusted. Surface the
      // not-positively-grounded findings here so the operator sees them; the
      // implement prompt additionally instructs the worker to verify such a
      // finding against the cited code before applying any fix (see
      // implementPrompt's grounding bullet). Findings are not dropped for being
      // ungrounded — they are flagged for verification, not blindly fixed.
      const needVerification = findings.filter((f) =>
        findingNeedsVerificationBeforeFix(f),
      );
      if (needVerification.length > 0) {
        console.warn(
          `Plan: ${needVerification.length} of ${findings.length} audit finding(s) are ungrounded or carry no grounding verdict; they will be verified-before-fix, not blindly applied: ${needVerification
            .map((f) => f.id)
            .join(", ")}`,
        );
      }
    } else {
      console.log(`Extracting findings from input via LLM: ${options.input}`);
      const extracted = await (deps.extractFindings
        ? deps.extractFindings(content, options)
        : extractFindingsWithProvider(content, state, options, deps));
      findings = extracted.findings;
      blocks = extracted.blocks;
      extractedFromProse = true;
    }
  } else {
    console.log(
      "No input provided or file does not exist. Halting Plan phase.",
    );
    throw new Error("Missing valid input for Plan phase.");
  }

  // Coverage accounting: snapshot the findings the plan received before any
  // reduction, so the ledger below can mark every source finding as
  // planned / folded / dropped — never silently lost.
  const sourceFindings = [...findings];

  // Deterministic grounding for LLM-extracted findings ONLY: strip phantom
  // affected_files paths, give all-phantom findings one bounded repair attempt,
  // drop the unrepaired, and classify evidence as grounded/ungrounded. The
  // structured audit-findings path above is exempt — auditor paths are already
  // grounded, and a since-deleted path there is the integrity check's replan
  // concern, not a reason to drop the finding.
  let grounding: ExtractedFindingGrounding | undefined;
  if (extractedFromProse) {
    grounding = await groundExtractedFindings(findings, {
      root: options.root,
      repairZeroPathFindings:
        deps.repairExtractedFindingPaths ??
        ((requests) =>
          repairExtractedFindingPathsWithProvider(requests, options, deps)),
    });
    findings = grounding.findings;
    if (grounding.phantomPathsByFinding.size > 0) {
      const strippedTotal = [...grounding.phantomPathsByFinding.values()].flat();
      console.warn(
        `Plan: grounding stripped ${strippedTotal.length} phantom path(s) across ${grounding.phantomPathsByFinding.size} extracted finding(s): ${strippedTotal.join(", ")}`,
      );
    }
    if (grounding.dropped.length > 0) {
      console.warn(
        `Plan: dropped ${grounding.dropped.length} extracted finding(s) with no real cited path after repair: ${grounding.dropped.map((d) => d.finding.id).join(", ")}`,
      );
      blocks = pruneBlocksForKeptFindings(blocks, findings);
    }
    if (grounding.ungroundedFindingIds.length > 0) {
      console.warn(
        `Plan: ${grounding.ungroundedFindingIds.length} extracted finding(s) have no evidence citing a real repo path (downgraded to low confidence): ${grounding.ungroundedFindingIds.join(", ")}`,
      );
    }
  }

  // Robustness: a finding with empty evidence fails the plan validator and would
  // abort the entire run. Skip such malformed findings (and prune them from
  // blocks) with a warning instead of crashing — findings are advisory, so one
  // bad finding must not block the whole report.
  const findingsWithoutEvidence = findings
    .filter((f) => !Array.isArray(f.evidence) || f.evidence.length === 0)
    .map((f) => f.id);
  if (findingsWithoutEvidence.length > 0) {
    console.warn(
      `Plan: skipping ${findingsWithoutEvidence.length} finding(s) with no evidence: ${findingsWithoutEvidence.join(", ")}`,
    );
    findings = findings.filter(
      (f) => Array.isArray(f.evidence) && f.evidence.length > 0,
    );
    blocks = pruneBlocksForKeptFindings(blocks, findings);
  }

  // Cross-lens dedup: merge findings that different audit lenses flagged independently
  const dedup = deduplicateCrossLensFindings(findings);
  findings = dedup.findings;
  blocks = fixupBlocksAfterDedup(blocks, dedup.mergeMap);

  // Intent checkpoint: drop findings the host filtered out (by severity / lens /
  // package / theme) or excluded by path, so only the requested work is planned.
  // Dropped findings are recorded in the coverage ledger and the final report.
  let intentCheckpoint: IntentCheckpoint | undefined;
  try {
    intentCheckpoint = await readOptionalJsonFile<IntentCheckpoint>(
      join(options.artifactsDir, "intent_checkpoint.json"),
    );
  } catch {
    console.warn(
      "Plan: intent_checkpoint.json was unreadable; ignoring checkpoint filters.",
    );
  }
  const { kept: keptFindings, droppedIds: droppedByCheckpoint } =
    filterFindingsByCheckpoint(findings, intentCheckpoint);
  if (droppedByCheckpoint.length > 0) {
    console.warn(
      `Plan: intent checkpoint dropped ${droppedByCheckpoint.length} finding(s) from remediation.`,
    );
    findings = keptFindings;
    blocks = pruneBlocksForKeptFindings(blocks, findings);
  }

  // Fallback blocks computation if none provided
  let blockStrategy: RemediationPlan["block_strategy"] | undefined;
  if (blocks.length === 0 && findings.length > 0) {
    const fallback = deriveFallbackBlocks(findings, options, deps);
    blocks = fallback.blocks;
    blockStrategy = fallback.blockStrategy;
  }

  // Apply the shared post-dedup pipeline (file-overlap merge, context-budget
  // split, and baseline file-hash snapshot). Extracted into applyPlanPipeline
  // so the LLM-extracted-plan path runs the exact same logic.
  ({
    blocks,
    findings,
  } = await applyPlanPipeline(
    {
      plan_id: "",
      findings,
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    options,
  ));

  // DC-1: fold the confirmed checkpoint's structured free_form_intent into block
  // and finding ORDERING (never filtering — that already happened above via the
  // checkpoint filters). The raw string is interpreted ONCE by the single shared
  // interpreter into lens/priority/scope signals (INV-S04: the verbatim string is
  // never read here and never reaches a worker prompt); emphasised work sorts
  // first. A blank/absent free_form_intent is a strict no-op.
  if (
    intentCheckpoint?.confirmed_by === "host" &&
    typeof intentCheckpoint.free_form_intent === "string" &&
    intentCheckpoint.free_form_intent.trim().length > 0
  ) {
    const interpreted = interpretFreeFormIntent(intentCheckpoint.free_form_intent);
    ({ findings, blocks } = applyIntentOrdering(findings, blocks, interpreted));
  }

  // Project command discovery (shared; now also covers Go and Python). The
  // RemediationPlan stores commands as strings, so argv arrays are joined.
  const commands = discoverProjectCommands(options.root);
  const testCommand = commands.test ? commands.test.join(" ") : undefined;
  const e2eCommand = commands.e2e ? commands.e2e.join(" ") : undefined;
  let projectType = "unknown";
  if (existsSync(join(options.root, "package.json"))) {
    projectType = "typescript-node";
  } else if (existsSync(join(options.root, "go.mod"))) {
    projectType = "go";
  } else if (
    existsSync(join(options.root, "pyproject.toml")) ||
    existsSync(join(options.root, "pytest.ini"))
  ) {
    projectType = "python";
  }

  const plan: RemediationPlan = {
    plan_id: "PLAN-" + (deps.now?.() ?? Date.now()),
    findings,
    blocks,
    project_type: projectType,
    test_command: testCommand,
    ...(e2eCommand ? { e2e_command: e2eCommand } : {}),
    candidate_closing_actions: ["none"],
    ...(blockStrategy ? { block_strategy: blockStrategy } : {}),
    ...(themes.length > 0 ? { themes } : {}),
  };

  const items: Record<string, RemediationItemState> = {};
  for (const finding of findings) {
    const block = blocks.find((b) => b.items.includes(finding.id));
    items[finding.id] = {
      finding_id: finding.id,
      status: "pending",
      block_id: block ? block.block_id : "UNKNOWN",
    };
  }

  // Coverage ledger: make every source finding's disposition auditable, so a
  // large source set consolidated into fewer items is recorded rather than lost.
  const coverage = buildCoverageLedger({
    planId: plan.plan_id,
    sourceFindings,
    droppedNoEvidence: findingsWithoutEvidence,
    droppedByCheckpoint,
    droppedPhantomPaths: new Map(
      (grounding?.dropped ?? []).map((d) => [d.finding.id, d.phantomPaths]),
    ),
    phantomPathsRemoved: grounding?.phantomPathsByFinding,
    mergeMap: dedup.mergeMap,
    items,
  });
  console.log(
    `Plan coverage: ${coverage.planned_count} planned, ${coverage.folded_count} folded, ${coverage.dropped_count} dropped (of ${coverage.source_finding_count} source finding(s)).`,
  );

  const planIssues = validateRemediationPlan(plan);
  if (planIssues.length > 0) {
    console.error(
      `Plan validation issues:\n${formatValidationIssues(planIssues)}`,
    );
    const errors = planIssues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        `Plan phase produced an invalid plan:\n${formatValidationIssues(errors)}`,
      );
    }
  }

  // Emit remediation_plan.json
  await writeJsonFile(
    join(options.artifactsDir, "remediation_plan.json"),
    plan,
  );

  return { ...state, status: "planning", plan, items, plan_coverage: coverage };
}

/**
 * Launch one bounded plan-phase LLM worker and read its result JSON. Shared by
 * the free-form extraction pass and the single bounded path-repair pass; the
 * label keys the per-task artifact files (task/prompt/result/stdout/stderr).
 */
async function runPlanWorkerTask<T>(params: {
  label: string;
  obligationId: string;
  buildPrompt: (io: { taskPath: string; resultPath: string }) => string;
  options: OrchestratorOptions;
  deps: PlanPhaseDeps;
}): Promise<T> {
  const { label, obligationId, buildPrompt, options, deps } = params;
  const sessionConfig =
    (await readOptionalJsonFile<SessionConfig>(
      join(options.root, "session-config.json"),
    )) || {};
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const workerTimeoutMs = sessionConfig.timeout_ms;

  const taskPath = join(options.artifactsDir, `task_${label}.json`);
  const resultPath = join(options.artifactsDir, `result_${label}.json`);
  const promptPath = join(options.artifactsDir, `prompt_${label}.md`);
  const stdoutPath = join(options.artifactsDir, `stdout_${label}.txt`);
  const stderrPath = join(options.artifactsDir, `stderr_${label}.txt`);

  await writeFile(promptPath, buildPrompt({ taskPath, resultPath }), "utf8");

  const task = createRemediationWorkerTask({
    runId: "PLAN-" + (deps.now?.() ?? Date.now()),
    options,
    obligationId,
    preferredExecutor: provider.name,
    resultPath,
    timeoutMs: workerTimeoutMs,
  });
  await writeJsonFile(taskPath, task);

  await provider.launch(
    createLaunchInputForTask(options, task, {
      promptPath,
      taskPath,
      stdoutPath,
      stderrPath,
    }),
  );
  return readJsonFile<T>(resultPath);
}

async function extractFindingsWithProvider(
  content: string,
  _state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): Promise<{ findings: Finding[]; blocks: RemediationBlock[] }> {
  try {
    const extracted = await runPlanWorkerTask<{
      findings: Finding[];
      blocks: RemediationBlock[];
    }>({
      label: "plan",
      obligationId: "extract-plan",
      options,
      deps,
      buildPrompt: ({ taskPath, resultPath }) =>
        `
You are the Remediation Assistant. Your task is to extract findings and work blocks from the provided document.
Produce a JSON output matching the remediation plan structure (specifically the findings and blocks arrays).

Grounding requirements (a deterministic validator checks every path you cite):
- Each \`affected_files[].path\` must be a repo-relative path that exists on disk. Verify before citing; never guess paths from prose.
- If you cannot identify a real file for a finding, emit an empty \`affected_files\` array instead of inventing one — discovery happens later.
- Each \`evidence\` entry should cite a real \`path:line\` location when one exists (e.g. "src/auth.ts:42 — token is never revoked"). Quote the source document only when no code location applies.

Document Content:
${content}

Your task JSON is at: ${taskPath}
Write your result JSON to exactly this path: ${resultPath}
Use the Write tool to create or overwrite that file.
Do not write to any other path.
    `.trim(),
    });
    return {
      findings: extracted.findings || [],
      blocks: extracted.blocks || [],
    };
  } catch (e) {
    console.error("Failed to extract plan via LLM:", e);
    throw new Error("Plan extraction failed.");
  }
}

/**
 * The single bounded repair attempt for extracted findings whose cited paths
 * were all phantom (WS1). Re-prompts the worker with the phantom paths named;
 * the worker either supplies real repo-relative paths or withdraws the finding.
 * The caller re-validates every returned path — repair output is untrusted.
 */
async function repairExtractedFindingPathsWithProvider(
  requests: { finding: Finding; phantomPaths: string[] }[],
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): Promise<Map<string, string[]>> {
  const findingSections = requests
    .map(
      ({ finding, phantomPaths }) => `
### ${finding.id} — ${finding.title}

- Summary: ${finding.summary}
- Evidence: ${(finding.evidence ?? []).join(" | ")}
- Phantom paths cited (do NOT exist in the repository): ${phantomPaths.join(", ")}`,
    )
    .join("\n");

  const repaired = await runPlanWorkerTask<{
    repairs?: { finding_id: string; affected_files: string[] }[];
  }>({
    label: "plan_path_repair",
    obligationId: "repair-extracted-paths",
    options,
    deps,
    buildPrompt: ({ taskPath, resultPath }) =>
      `
You are the Remediation Assistant. Earlier extraction cited file paths that do not exist in the repository. For each finding below, locate the REAL repo-relative path(s) the finding is about (search the repository), or withdraw the finding if it does not apply to this codebase.
${findingSections}

Rules:
- Cite only repo-relative paths that exist on disk; verify each one before writing it.
- To withdraw a finding, return it with an empty \`affected_files\` array (or omit it).
- Do not edit source files.

Your task JSON is at: ${taskPath}
Write your result JSON to exactly this path: ${resultPath}

\`\`\`json
{
  "repairs": [
    { "finding_id": "FINDING-001", "affected_files": ["real/path/to/file.ts"] }
  ]
}
\`\`\`
`.trim(),
  });

  return new Map(
    (repaired.repairs ?? [])
      .filter((entry) => typeof entry?.finding_id === "string")
      .map((entry) => [
        entry.finding_id,
        Array.isArray(entry.affected_files)
          ? entry.affected_files.filter((p): p is string => typeof p === "string")
          : [],
      ]),
  );
}
