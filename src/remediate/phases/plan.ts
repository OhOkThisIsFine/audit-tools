import {
  RemediationPlan,
  Finding,
  RemediationBlock,
  RemediationItemState,
  CoverageLedger,
  CoverageLedgerEntry,
} from "../state/types.js";
import { isAbsolute, join } from "node:path";
import type { AuditFindingsReport } from "audit-tools/shared";
import { canonicalizeFilePath, claimsAuditFindingsContract, compareCodeUnits } from "audit-tools/shared";
import { readdirSync, statSync } from "node:fs";
import { snapshotAffectedFileHashes } from "../utils/fileIntegrity.js";
import {
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
} from "audit-tools/shared";

/**
 * Whether a parsed JSON value claims the audit-findings contract — the ROUTING
 * predicate for structured vs markdown/freeform input.
 *
 * INV-remediate-state-07: contract_version presence and expected value are
 * enforced here — an absent or mismatched contract_version never routes
 * structured. Deliberately NOT the full strict validator: a report that claims
 * the contract but is internally invalid must enter the structured path and be
 * refused there with its real issues, not silently fall through to the
 * markdown parser.
 */
export function isAuditFindingsReport(
  value: unknown,
): value is AuditFindingsReport {
  return claimsAuditFindingsContract(value);
}

// Block-sizing constants: now single-sourced from audit-tools/shared.
// Re-exported under their legacy names so any callers outside this package
// (and dispatch.ts) can migrate to the shared constants at their own pace.
export {
  ESTIMATED_PROMPT_OVERHEAD_TOKENS as ESTIMATED_BLOCK_BASE_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS as ESTIMATED_FINDING_OVERHEAD_TOKENS,
} from "audit-tools/shared";

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

function addAdvisoryTokenEstimates(
  blocks: RemediationBlock[],
  findings: Finding[],
  root: string,
): RemediationBlock[] {
  const findingMap = new Map(findings.map((finding) => [finding.id, finding]));
  const files = new Map<string, string>();
  for (const block of blocks) {
    for (const findingId of block.items) {
      for (const affectedFile of findingMap.get(findingId)?.affected_files ?? []) {
        const key = canonicalizeFilePath(affectedFile.path, { root });
        if (!files.has(key)) files.set(key, affectedFile.path);
      }
    }
  }

  const byteCounts = new Map<string, number>();
  for (const [key, path] of files) {
    byteCounts.set(key, fileSizeBytes(path, root));
  }

  return blocks.map((block) => ({
    ...block,
    token_estimate: estimateGroupTokens(
      block.items,
      findings,
      byteCounts,
      root,
    ),
  }));
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
  const entries: CoverageLedgerEntry[] = [...params.sourceFindings]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((f) => {
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
 * Applies the backend-independent post-dedup steps that every plan must go through
 * before being handed off to the implement phase:
 *
 *   1. mergeBlocksSharingFiles — preserves content-coherent membership while
 *      annotating independent co-file work
 *   2. addAdvisoryTokenEstimates — reports deterministic local size metadata
 *   3. snapshotAffectedFileHashes — records trusted baseline hashes
 *
 * Sole caller is handlePendingExtractedPlan (LLM-extracted plans join site);
 * kept as its own function so the post-dedup logic has one home.
 */
export async function applyPlanPipeline(
  plan: RemediationPlan,
  options: { root: string; artifactsDir?: string },
): Promise<RemediationPlan> {
  let { findings, blocks } = plan;

  // Merge blocks whose findings touch a shared file.
  blocks = mergeBlocksSharingFiles(blocks, findings, options.root);

  // Membership is a content-coherence contract. Planning reports size to the
  // host but never reshapes work around a backend's context window.
  blocks = addAdvisoryTokenEstimates(blocks, findings, options.root);

  // Record baseline file hashes for the integrity check that runs before dispatch.
  snapshotAffectedFileHashes(options.root, findings);

  return { ...plan, findings, blocks };
}
