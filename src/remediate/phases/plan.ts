import {
  RemediationPlan,
  Finding,
  RemediationBlock,
  RemediationItemState,
  CoverageLedger,
  CoverageLedgerEntry,
} from "../state/types.js";
import { isAbsolute, join } from "node:path";
import type { AuditFindingsReport, FindingTheme } from "audit-tools/shared";
import { isValidAuditFindingsReport } from "audit-tools/shared";
import { readdirSync, statSync } from "node:fs";
import { snapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  readValidatedSessionConfig,
  resolveContextBudget,
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  chunkByBudget,
  type SessionConfig,
} from "audit-tools/shared";
import { canonicalizeFilePath } from "../dispatch/ownershipRegistry.js";

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

// Thin adapter over the shared `chunkByBudget` greedy chunker (extracted
// alongside chunkPacketTasks in audit's reviewPackets.ts and chunkByTaskBudget
// in audit's taskBuilder.ts — three previously byte-identical loop shapes).
// The already-fits/singleton bypass is kept as a call-site guard since it
// returns the group unsplit rather than delegating to the generic loop.
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

  return chunkByBudget(group, {
    budget: contextBudget,
    costOf: (candidate) => estimateGroupTokens(candidate, findings, fileByteCounts, root),
  });
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
          // A split same-file block keeps its co-file parallel
          // eligibility — carry cofile_parallel_safe onto every sub-block.
          ...(block.cofile_parallel_safe !== undefined
            ? { cofile_parallel_safe: block.cofile_parallel_safe }
            : {}),
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
 * Reconcile blocks whose findings touch a shared file.
 *
 * A3 decomposition seam: two blocks that share a canonical physical file but come
 * from INDEPENDENT findings (distinct finding ids, no dependency edge ordering
 * them) are NO LONGER unioned into one serial block. They are kept SEPARATE and
 * each is flagged `cofile_parallel_safe=true` — a mechanical decision that the
 * findings are independent, NOT a proof of edit-region disjointness; correctness
 * is enforced later at merge by git (a real overlap surfaces as a conflict). Only
 * a genuine ordering dependency (an existing dependency edge between the two
 * blocks) keeps them serialized — and ordered blocks were never unioned anyway,
 * they simply run in dependency order. A single finding whose fix spans multiple
 * regions of one file is one block already and is never split.
 *
 * File identity uses `canonicalizeFilePath` (the one M1-BOUNDARY scheme) so
 * `src/A.ts`, `./src/A.ts`, `src\A.ts` and case variants collide on one key.
 * Pure; preserves the auditor's structure otherwise.
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
  // detected as sharing it.
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

  // Detect which blocks share a canonical file with another block WITHOUT a
  // dependency edge ordering them: these are the independent co-file blocks that
  // stay separate and get flagged parallel-safe. Ordered co-file pairs already
  // serialize via their dependency edge and need no flag.
  const fileSets = blocks.map(fileSet);
  const cofileIndependent = new Array<boolean>(blocks.length).fill(false);
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const shareFile = [...fileSets[i]].some((p) => fileSets[j].has(p));
      if (!shareFile) continue;
      if (ordered(blocks[i].block_id, blocks[j].block_id)) continue;
      cofileIndependent[i] = true;
      cofileIndependent[j] = true;
    }
  }

  if (!cofileIndependent.some(Boolean)) return blocks; // nothing to flag

  // Keep every block SEPARATE (no union). Flag the independent co-file blocks as
  // parallel-safe; leave others untouched.
  return blocks.map((b, i) =>
    cofileIndependent[i] ? { ...b, cofile_parallel_safe: true } : b,
  );
}

/**
 * Applies the three post-dedup pipeline steps that every plan must go through
 * before being handed off to the implement phase:
 *
 *   1. mergeBlocksSharingFiles  — prevents parallel workers clobbering the same file
 *   2. splitBlocksByContextBudget — keeps each block within the agent context window
 *   3. snapshotAffectedFileHashes — records baseline hashes for integrity checks
 *
 * Sole caller is handlePendingExtractedPlan (LLM-extracted plans join site);
 * kept as its own function so the post-dedup logic has one home.
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
  const sessionConfig = await readValidatedSessionConfig(
    join(options.root, "session-config.json"),
  );
  const contextBudget = resolveContextBudgetFromConfig(sessionConfig ?? null);
  blocks = splitBlocksByContextBudget(blocks, findings, options.root, contextBudget);

  // Record baseline file hashes for the integrity check that runs before dispatch.
  snapshotAffectedFileHashes(options.root, findings);

  return { ...plan, blocks };
}

