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
import type { AuditFindingsReport, FindingTheme } from "@audit-tools/shared";
import { existsSync, readdirSync, statSync } from "node:fs";
import { snapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  readOptionalJsonFile,
  writeJsonFile,
  readJsonFile,
  formatValidationIssues,
  discoverProjectCommands,
  resolveContextBudget,
  estimateTokensFromBytes,
  type SessionConfig,
} from "@audit-tools/shared";
import { createFreshSessionProvider } from "../providers/index.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import {
  validateRemediationPlan,
  validateFinding,
} from "../validation/remediationState.js";
import { runCommand } from "../utils/commands.js";
import {
  createLaunchInputForTask,
  createRemediationWorkerTask,
} from "./workerTasks.js";

const PUBLIC_CONTRACT_SCHEMA_COMPANIONS = new Map<string, string[]>([
  [
    "packages/shared/src/types/finding.ts",
    ["packages/audit-code/schemas/audit_findings.schema.json"],
  ],
]);

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
      }))
    : [];
  const themes = Array.isArray(report.themes) ? report.themes : [];
  return { findings, blocks, themes };
}

/** Whether a parsed JSON value looks like the auditor's audit-findings report. */
export function isAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<AuditFindingsReport>;
  return (
    Array.isArray(report.findings) &&
    (typeof report.contract_version === "string" ||
      Array.isArray(report.work_blocks))
  );
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

function appendPublicContractSchemaCompanions(findings: Finding[]): Finding[] {
  for (const finding of findings) {
    const seen = new Set(finding.affected_files.map((file) => file.path));
    const companionPaths: string[] = [];
    for (const affectedFile of finding.affected_files) {
      for (const companion of PUBLIC_CONTRACT_SCHEMA_COMPANIONS.get(
        affectedFile.path,
      ) ?? []) {
        if (seen.has(companion)) continue;
        seen.add(companion);
        companionPaths.push(companion);
      }
    }
    for (const companion of companionPaths) {
      finding.affected_files.push({ path: companion });
    }
  }
  return findings;
}

interface PlanPhaseDeps {
  enumerateTestFiles?: (root: string) => string[];
  runCommand?: typeof runCommand;
  now?: () => number;
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
    block = { block_id: blockId, items: [], parallel_safe: true };
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

// Block-sizing constants specific to the remediator (the per-line ratio is the
// shared `ESTIMATED_TOKENS_PER_LINE`; the model-limit table and budget math now
// live in @audit-tools/shared).
export const ESTIMATED_BLOCK_BASE_TOKENS = 900;
export const ESTIMATED_FINDING_OVERHEAD_TOKENS = 600;

function resolveContextBudgetFromConfig(sessionConfig: SessionConfig | null): number {
  const quota = sessionConfig?.block_quota ?? {};
  return resolveContextBudget({
    contextTokens: quota.context_tokens ?? null,
    reservedOutputTokens: quota.reserved_output_tokens ?? null,
    hostModel: quota.host_model ?? null,
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
      const list = fileToIds.get(af.path) ?? [];
      list.push(id);
      fileToIds.set(af.path, list);
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

function estimateGroupTokens(
  findingIds: string[],
  findings: Finding[],
  fileByteCounts: Map<string, number>,
): number {
  const uniqueFiles = new Set<string>();
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const id of findingIds) {
    for (const af of findingMap.get(id)?.affected_files ?? []) uniqueFiles.add(af.path);
  }
  const totalBytes = [...uniqueFiles].reduce((sum, p) => sum + (fileByteCounts.get(p) ?? 0), 0);
  return (
    ESTIMATED_BLOCK_BASE_TOKENS +
    estimateTokensFromBytes(totalBytes) +
    findingIds.length * ESTIMATED_FINDING_OVERHEAD_TOKENS
  );
}

function splitOversizedOverlapGroup(
  group: string[],
  findings: Finding[],
  fileByteCounts: Map<string, number>,
  contextBudget: number,
): string[][] {
  if (
    group.length <= 1 ||
    estimateGroupTokens(group, findings, fileByteCounts) <= contextBudget
  ) {
    return [group];
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  for (const findingId of group) {
    const candidate = [...current, findingId];
    if (
      current.length > 0 &&
      estimateGroupTokens(candidate, findings, fileByteCounts) > contextBudget
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
  const allFiles = new Set<string>();
  const findingMap = new Map(findings.map((f) => [f.id, f]));
  for (const block of blocks) {
    for (const id of block.items) {
      for (const af of findingMap.get(id)?.affected_files ?? []) allFiles.add(af.path);
    }
  }

  const fileByteCounts = new Map<string, number>();
  for (const filePath of allFiles) {
    fileByteCounts.set(filePath, fileSizeBytes(filePath, root));
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
      );
      for (const group of groups) {
        const groupTokens = estimateGroupTokens(group, findings, fileByteCounts);
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
    })),
    blockStrategy: "file_overlap",
  };
}

/**
 * Account for every finding the plan received: each is marked `planned` (kept and
 * mapped to a block), `folded_into` (merged into a survivor by cross-lens dedup), or
 * `dropped_no_evidence` (excluded for carrying no evidence). The three dispositions
 * are mutually exclusive and cover the whole source set, so nothing is lost silently.
 */
export function buildCoverageLedger(params: {
  planId: string;
  sourceFindings: Finding[];
  droppedNoEvidence: string[];
  mergeMap: Map<string, string>;
  items: Record<string, RemediationItemState>;
}): CoverageLedger {
  const dropped = new Set(params.droppedNoEvidence);
  const entries: CoverageLedgerEntry[] = params.sourceFindings.map((f) => {
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
      };
    }
    return {
      finding_id: f.id,
      title: f.title,
      disposition: "planned",
      block_id: params.items[f.id]?.block_id,
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

  const fileSet = (b: RemediationBlock): Set<string> => {
    const files = new Set<string>();
    for (const id of b.items) {
      for (const af of findingMap.get(id)?.affected_files ?? []) {
        if (!isDirectoryPath(af.path, root)) files.add(af.path);
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
    return {
      block_id: mergedId,
      items,
      parallel_safe,
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
  let { blocks, findings } = plan;

  findings = appendPublicContractSchemaCompanions(findings);

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

export async function runPlanPhase(
  state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps = {},
): Promise<RemediationState> {
  console.log("Running Plan Phase...");

  let findings: Finding[] = [];
  let blocks: RemediationBlock[] = [];
  let themes: FindingTheme[] = [];

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
    } else {
      console.log(`Extracting findings from input via LLM: ${options.input}`);
      const extracted = await extractFindingsWithProvider(
        content,
        state,
        options,
        deps,
      );
      findings = extracted.findings;
      blocks = extracted.blocks;
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
    const keptIds = new Set(findings.map((f) => f.id));
    blocks = blocks
      .map((b) => ({ ...b, items: (b.items ?? []).filter((id) => keptIds.has(id)) }))
      .filter((b) => (b.items ?? []).length > 0);
  }

  // Cross-lens dedup: merge findings that different audit lenses flagged independently
  const dedup = deduplicateCrossLensFindings(findings);
  findings = dedup.findings;
  blocks = fixupBlocksAfterDedup(blocks, dedup.mergeMap);

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

async function extractFindingsWithProvider(
  content: string,
  _state: RemediationState,
  options: OrchestratorOptions,
  deps: PlanPhaseDeps,
): Promise<{ findings: Finding[]; blocks: RemediationBlock[] }> {
  const sessionConfig =
    (await readOptionalJsonFile<SessionConfig>(
      join(options.root, "session-config.json"),
    )) || {};
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const workerTimeoutMs = sessionConfig.timeout_ms;

  const taskPath = join(options.artifactsDir, `task_plan.json`);
  const resultPath = join(options.artifactsDir, `result_plan.json`);

  const promptPath = join(options.artifactsDir, `prompt_plan.md`);
  const promptContent = `
You are the Remediation Assistant. Your task is to extract findings and work blocks from the provided document.
Produce a JSON output matching the remediation_plan.schema.json structure (specifically the findings and blocks arrays).

Document Content:
${content}

Your task JSON is at: ${taskPath}
Write your result JSON to exactly this path: ${resultPath}
Use the Write tool to create or overwrite that file.
Do not write to any other path.
    `.trim();
  await writeFile(promptPath, promptContent, "utf8");
  const stdoutPath = join(options.artifactsDir, `stdout_plan.txt`);
  const stderrPath = join(options.artifactsDir, `stderr_plan.txt`);

  const task = createRemediationWorkerTask({
    runId: "PLAN-" + (deps.now?.() ?? Date.now()),
    options,
    obligationId: "extract-plan",
    preferredExecutor: provider.name,
    resultPath,
    timeoutMs: workerTimeoutMs,
  });
  await writeJsonFile(taskPath, task);

  try {
    await provider.launch(
      createLaunchInputForTask(options, task, {
        promptPath,
        taskPath,
        stdoutPath,
        stderrPath,
      }),
    );
    const extracted = await readJsonFile<{
      findings: Finding[];
      blocks: RemediationBlock[];
    }>(resultPath);
    return {
      findings: extracted.findings || [],
      blocks: extracted.blocks || [],
    };
  } catch (e) {
    console.error("Failed to extract plan via LLM:", e);
    throw new Error("Plan extraction failed.");
  }
}
