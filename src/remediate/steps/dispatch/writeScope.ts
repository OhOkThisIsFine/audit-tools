import { OwnershipRegistry } from "../../dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../../dispatch/amendmentClaim.js";
import { toBlockId, fromBlockId } from "../../contractPipeline/idRegistry.js";
import { AGENT_FEEDBACK_FILENAME } from "audit-tools/shared";
import type { RemediationState } from "../../state/store.js";
import type { RemediationBlock } from "../../state/types.js";
import type { ImplementWorkerResult, RemediationDispatchPlan } from "../types.js";
import {
  isSkipStatus,
  isVerifiedCompleteStatus,
} from "../../state/itemStatus.js";
import {
  toRepoRelative,
  writeScopeViolations,
  gitEditedFilesForBranch,
  type GitEditedFiles,
  type GitBranchHunk,
  type GitBranchHunks,
} from "./common.js";
import { reconciliationExpectationsOf } from "./dagNodeFields.js";

/** The decision a write-scope gate makes given the resolved edit set. */
export interface WriteScopeDecision {
  blocked: boolean;
  reason?: string;
}

/**
 * Pure write-scope gate decision (OBL-DS-06). Given the block's declared write
 * paths and the resolved git edit set:
 *  - `not_a_repo`   → no ground truth (no worktree workflow) → not blocked.
 *  - `probe_failed` → git is a repo but the diff failed → FAIL CLOSED (blocked).
 *  - available      → block iff any edited file is outside declared scope.
 * The worker's self-reported `amended_files` is never an input here.
 */
export function enforceWriteScope(
  declaredWritePaths: string[],
  edited: GitEditedFiles,
  root: string,
): WriteScopeDecision {
  if (!edited.available) {
    if (edited.reason === "not_a_repo") {
      return { blocked: false };
    }
    // probe_failed: git is present but could not be queried → fail closed.
    return {
      blocked: true,
      reason:
        `Write-scope could not be verified: git probe failed (${edited.error}). ` +
        `Failing closed rather than trusting self-reported edits.`,
    };
  }
  const violations = writeScopeViolations(declaredWritePaths, edited.files, root);
  if (violations.length === 0) return { blocked: false };
  return {
    blocked: true,
    reason:
      `Worker edited files outside its declared write scope: ${violations.join(", ")}. ` +
      `Declared scope must be amended through the seam protocol; the self-reported ` +
      `amended_files set is not trusted for this gate.`,
  };
}

/** Each block's declared write scope from a dispatch plan — the seed for the
 *  accept-time write-scope gate's ownership registry (so an amended path owned by
 *  a sibling block is recognised as a seam conflict, not silently granted). */
export function blockScopesFromPlan(
  plan: RemediationDispatchPlan,
): Array<{ block_id: string; write_paths: string[] }> {
  return plan.items.flatMap((item) =>
    item.block_id && item.access
      ? [{ block_id: item.block_id, write_paths: item.access.write_paths }]
      : [],
  );
}

/**
 * A block's declared target paths (write ∪ read) from the persisted dispatch plan
 * — the single source of the scope the worker actually received (same authority
 * the accept-time write-scope gate reads). Used to seed untracked declared targets
 * into a fresh worktree (see {@link seedUntrackedDeclaredPaths}).
 */
export function declaredPathsFromPlan(
  plan: RemediationDispatchPlan,
  blockId: string,
): string[] {
  const item = plan.items.find((i) => i.block_id === blockId);
  if (!item?.access) return [];
  return [...(item.access.write_paths ?? []), ...(item.access.read_paths ?? [])];
}

/**
 * Pure write-scope adjudication (OBL-DS-06) — git-free so it is unit-testable with
 * a synthetic edit set. Seeds an ephemeral `OwnershipRegistry` from `allBlockScopes`
 * (normalised to repo-relative so ownership compares like-for-like) and routes the
 * node's ACTUAL out-of-declared edits — the git ground truth, never a self-report:
 *  - an edit to a file no sibling block owns is granted and widens this node's
 *    effective scope (a too-narrow — or empty — declared scope no longer blocks a
 *    correct fix; this is the sanctioned "extend into unowned files" path);
 *  - an edit to a file in another block's declared scope is a seam conflict that
 *    blocks until the seam protocol re-scopes or serialises the nodes.
 * Cross-sibling contention on a file two live nodes both touch (neither declared)
 * is left to the merge-time lost-update detector (`detectOverlappingEdits`), which
 * sees the full set of merged blocks a single accept cannot.
 */
export function adjudicateWriteScope(
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>,
  blockId: string,
  edited: GitEditedFiles,
  root: string,
): WriteScopeDecision {
  const registry = new OwnershipRegistry();
  registry.initialize(
    allBlockScopes.map((b) => ({
      node_id: b.block_id,
      write_paths: b.write_paths.map((p) => toRepoRelative(p, root)),
    })),
  );
  if (edited.available) {
    // The node's real source edits outside its declared scope (sanctioned side
    // outputs already excluded by writeScopeViolations).
    const candidates = writeScopeViolations(registry.getScope(blockId), edited.files, root);
    if (candidates.length > 0) {
      const { seam_routed } = routeAmendmentRequest(registry, blockId, candidates);
      if (seam_routed.length > 0) {
        const detail = seam_routed
          .map((r) => {
            const reason = r.reason;
            if (reason.outcome === "owned") return `${r.path} owned by ${reason.owner_node_id}`;
            if (reason.outcome === "contended") {
              return `${r.path} contended by ${reason.sibling_node_id}`;
            }
            return r.path;
          })
          .join("; ");
        return {
          blocked: true,
          reason:
            `Node edited files owned by another block (seam conflict): ${detail}. ` +
            `Resolve via the seam protocol (re-scope contracts or serialise the nodes) before this node can land.`,
        };
      }
      // every candidate was unowned → granted into this node's effective scope.
    }
  }
  return enforceWriteScope(registry.getScope(blockId), edited, root);
}

/**
 * Accept-time write-scope gate, run from `acceptNodeWorktree` AFTER the verify and
 * BEFORE the cherry-pick so a violation PREVENTS the merge rather than being
 * reported once the edit already landed in main. Thin git wrapper around
 * {@link adjudicateWriteScope}: resolves the branch's actual edits and adjudicates.
 */
export function enforceAcceptWriteScope(params: {
  root: string;
  branch: string;
  blockId: string;
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
}): WriteScopeDecision {
  const { root, branch, blockId, allBlockScopes } = params;
  return adjudicateWriteScope(
    allBlockScopes,
    blockId,
    gitEditedFilesForBranch(root, branch),
    root,
  );
}

// ---------------------------------------------------------------------------
// Merge-seam: obligation-id → node remap + multi-entry collapse (tolerance)
// ---------------------------------------------------------------------------

/**
 * Build the map from a known obligation/node alias to the finding id that owns
 * it, for one block. A worker that mislabels its `finding_id` as an obligation
 * id it was assigned (or a CP-BLOCK-prefixed/unprefixed node alias) is remapped
 * to the owning node's finding rather than dropped as an orphan — the tolerant
 * seam (the host is a variable of any strength). The map only ever points at
 * findings that belong to THIS block, so a mislabel can never resolve to an
 * unrelated node.
 */
export function buildBlockAliasMap(
  block: RemediationBlock,
  state: RemediationState,
): Map<string, string> {
  const aliasToFinding = new Map<string, string>();
  for (const findingId of block.items) {
    const finding = state.plan?.findings.find((f) => f.id === findingId);
    if (!finding) continue;
    // The node id itself, and its block-prefixed / unprefixed aliases.
    const register = (alias: string | undefined) => {
      if (!alias || alias === findingId) return;
      if (!aliasToFinding.has(alias)) aliasToFinding.set(alias, findingId);
    };
    // CP-BLOCK- aliases are now resolved deterministically by the id registry in
    // `collapseItemResults` (S4); registering them here is defence-in-depth only.
    register(toBlockId(findingId));
    register(block.block_id);
    // The obligation ids the node satisfies/verifies — a worker may report one.
    for (const obl of [
      ...(finding.contract_obligation_ids ?? []),
      ...(finding.verification_obligation_ids ?? []),
    ]) {
      register(obl);
    }
  }
  return aliasToFinding;
}

/**
 * Collapse a worker result's `item_results` to one entry per resolved finding
 * id, applying the block alias map first (obligation/node-alias → finding). When
 * several entries collapse onto the same finding, a single `blocked` entry wins
 * over `resolved` (a node is not complete if any reported facet failed), and the
 * union of evidence / first failure_reason is preserved. Entries whose id is
 * neither a known finding nor a known alias are returned in `unresolved` so the
 * caller can record them as orphans.
 */
export function collapseItemResults(
  itemResults: ImplementWorkerResult["item_results"],
  aliasMap: Map<string, string>,
  knownFindingIds: Set<string>,
): {
  collapsed: ImplementWorkerResult["item_results"];
  unresolved: ImplementWorkerResult["item_results"];
} {
  const byFinding = new Map<string, ImplementWorkerResult["item_results"][number]>();
  const unresolved: ImplementWorkerResult["item_results"] = [];
  for (const entry of itemResults) {
    let targetId = entry.finding_id;
    if (!knownFindingIds.has(targetId)) {
      // Registry-authoritative (S4): a CP-BLOCK- block id maps deterministically
      // to its bare node id via the id registry, so the common "worker reported
      // the block id" mislabel resolves here without the tolerant alias remap —
      // the remap is defence-in-depth for non-block aliases (e.g. a mislabelled
      // obligation id) only.
      const nodeId = fromBlockId(targetId);
      if (nodeId && knownFindingIds.has(nodeId)) {
        targetId = nodeId;
      } else {
        const remapped = aliasMap.get(targetId);
        if (remapped) {
          targetId = remapped;
        } else {
          unresolved.push(entry);
          continue;
        }
      }
    }
    const normalized = { ...entry, finding_id: targetId };
    const existing = byFinding.get(targetId);
    if (!existing) {
      byFinding.set(targetId, normalized);
      continue;
    }
    // Collapse precedence: blocked > needs_clarification > resolved >
    // resolved_no_change. A hard failure dominates an unanswered scoping question,
    // which dominates an actual change, which dominates a no-change claim (a
    // no-change claim only survives if every entry agreed nothing changed). Merge
    // evidence; keep first failure_reason / clarification question.
    const mergedEvidence = [
      ...new Set([...(existing.evidence ?? []), ...(normalized.evidence ?? [])]),
    ];
    const status: ImplementWorkerResult["item_results"][number]["status"] =
      existing.status === "blocked" || normalized.status === "blocked"
        ? "blocked"
        : existing.status === "needs_clarification" || normalized.status === "needs_clarification"
          ? "needs_clarification"
          : existing.status === "resolved" || normalized.status === "resolved"
            ? "resolved"
            : "resolved_no_change";
    byFinding.set(targetId, {
      finding_id: targetId,
      status,
      evidence: mergedEvidence.length > 0 ? mergedEvidence : undefined,
      failure_reason: existing.failure_reason ?? normalized.failure_reason,
      clarification_question:
        existing.clarification_question ?? normalized.clarification_question,
      clarification_category:
        existing.clarification_category ?? normalized.clarification_category,
    });
  }
  return { collapsed: [...byFinding.values()], unresolved };
}

// ---------------------------------------------------------------------------
// Merge-seam: per-node disposition (INV-DS-15) + sibling-red routing (INV-DS-14)
// ---------------------------------------------------------------------------

export type NodeDispositionStatus =
  | "verified_complete"
  | "blocked"
  | "skipped"
  | "missing_result";

export interface NodeDisposition {
  node_id: string;
  block_id: string;
  disposition: NodeDispositionStatus;
  /** The state status the node's finding(s) ended in. */
  finding_status: string;
  /** Reconciliation expectations the node was responsible for honoring (INV-DS-12). */
  reconciliation_expectations: string[];
  /** Why the node landed in this disposition (failure_reason / skip reason). */
  reason?: string;
}

/**
 * Build the per-node disposition for a block (INV-DS-15). A SKIP disposition
 * (user-skipped: `ignored` / `deemed_inappropriate`) is NEVER reported as
 * `verified_complete`. Each block maps 1:1 to a node, so the disposition keys on
 * the block's first finding (the node id).
 */
export function buildNodeDisposition(
  block: RemediationBlock,
  state: RemediationState,
): NodeDisposition {
  const nodeId = block.items[0] ?? block.block_id;
  const finding = state.plan?.findings.find((f) => f.id === nodeId);
  // Resolve the block's overall status from its items.
  const statuses = block.items.map((id) => state.items?.[id]?.status ?? "pending");
  const isSkip = statuses.some((s) => isSkipStatus(s));
  const allResolved =
    statuses.length > 0 && statuses.every((s) => isVerifiedCompleteStatus(s));
  const anyBlocked = statuses.some((s) => s === "blocked");
  let disposition: NodeDispositionStatus;
  if (isSkip) {
    // INV-DS-15: a skipped node is never verified_complete.
    disposition = "skipped";
  } else if (anyBlocked) {
    disposition = "blocked";
  } else if (allResolved) {
    disposition = "verified_complete";
  } else {
    disposition = "missing_result";
  }
  const reason = block.items
    .map((id) => state.items?.[id]?.failure_reason)
    .find((r): r is string => typeof r === "string" && r.length > 0);
  return {
    node_id: nodeId,
    block_id: block.block_id,
    disposition,
    finding_status: statuses.join(","),
    reconciliation_expectations: finding ? reconciliationExpectationsOf(finding) : [],
    reason,
  };
}

/**
 * Attribute a post-merge sibling-block failure (INV-DS-14). Given the repo-
 * relative paths implicated by a red sibling and the merged blocks' declared
 * write scopes, return the exactly-one block whose scope contains an implicated
 * file (attributable → route THAT sibling to triage). When zero or more than one
 * merged block could own the failure, the red is unattributable and is deferred
 * to the rolling-scheduler's coarse backstop (return null).
 */
export function attributeSiblingRed(
  implicatedFiles: string[],
  mergedBlockScopes: Array<{ block_id: string; write_paths: string[] }>,
  root: string,
): string | null {
  const implicated = new Set(implicatedFiles.map((p) => toRepoRelative(p, root)));
  const owners = new Set<string>();
  for (const { block_id, write_paths } of mergedBlockScopes) {
    for (const wp of write_paths) {
      if (implicated.has(toRepoRelative(wp, root))) {
        owners.add(block_id);
        break;
      }
    }
  }
  // Attributable only when a single merged block owns the implicated surface.
  return owners.size === 1 ? [...owners][0] : null;
}

// ---------------------------------------------------------------------------
// Merge-seam: lost-update / overlapping-edit detection (ARC-f378135d-2 / ARC-c1693139)
// ---------------------------------------------------------------------------

/** A merged block's ACTUAL edited file set (resolved from its worktree branch diff). */
export interface BlockEditedFiles {
  block_id: string;
  /** Repo-relative forward-slash paths the block's worker actually changed. */
  files: Set<string>;
  /**
   * The block's ACTUAL edited hunks (new-side line ranges), when git could
   * resolve them. When absent / unavailable, {@link detectOverlappingEdits} MUST
   * fail closed and treat any same-file pairing as a potential collision — a
   * missing hunk map is never disjointness evidence.
   */
  hunks?: GitBranchHunks;
}

/** One detected overlap: two merged blocks whose actual edits hit the same file. */
export interface OverlappingEdit {
  path: string;
  block_ids: string[];
}

/**
 * Detect lost-update hazards across concurrently-merged blocks (ARC-f378135d-2 /
 * ARC-c1693139). When the rolling engine dispatches multiple nodes in flight and
 * each worker edits in its own worktree, two workers can both modify the SAME
 * file; cherry-picking both branches silently drops one worker's change to that
 * file (lost update). This pure function returns every repo-relative path that
 * appears in more than one merged block's ACTUAL edit set, with the owning block
 * ids. The caller routes the involved blocks to triage so the conflict is
 * reconciled rather than silently losing an edit. Result-file artifacts and the
 * agent-feedback file are sanctioned side outputs and are never counted as
 * overlaps.
 */
export function detectOverlappingEdits(
  editedByBlock: BlockEditedFiles[],
): OverlappingEdit[] {
  const isSanctionedSideOutput = (rel: string): boolean =>
    rel.endsWith(".result.json") || rel.endsWith(AGENT_FEEDBACK_FILENAME);

  // path → block_id → the block's hunks for that path (undefined when hunk info
  // is unavailable for the block, which forces the conservative fail-closed path).
  const pathToBlockHunks = new Map<string, Map<string, GitBranchHunk[] | undefined>>();
  for (const { block_id, files, hunks } of editedByBlock) {
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      // Sanctioned non-source outputs never constitute a lost-update conflict.
      if (isSanctionedSideOutput(rel)) continue;
      let byBlock = pathToBlockHunks.get(rel);
      if (!byBlock) {
        byBlock = new Map();
        pathToBlockHunks.set(rel, byBlock);
      }
      // Hunk info is only usable when git resolved it AND this block edited this
      // file per its hunk set. `available:false` (or an absent map) → undefined,
      // which detectOverlap treats as "cannot prove disjoint" → collision stands.
      const fileHunks =
        hunks?.available === true
          ? hunks.hunks.filter((h) => h.file === rel)
          : undefined;
      byBlock.set(block_id, fileHunks);
    }
  }

  const overlaps: OverlappingEdit[] = [];
  for (const [path, byBlock] of pathToBlockHunks) {
    if (byBlock.size <= 1) continue;
    const owners = [...byBlock.keys()].sort();
    // A file is a lost-update hazard iff SOME pair of owning blocks has edits we
    // cannot prove disjoint. If EVERY pair's hunks are known and disjoint, the
    // cherry-picks compose cleanly → not a collision. Any pair with unavailable
    // hunks fails closed (treated as overlapping).
    let collides = false;
    outer: for (let i = 0; i < owners.length; i++) {
      for (let j = i + 1; j < owners.length; j++) {
        const a = byBlock.get(owners[i]);
        const b = byBlock.get(owners[j]);
        if (a === undefined || b === undefined) {
          collides = true; // fail closed: no proof of disjointness.
          break outer;
        }
        if (hunkRangesOverlap(a, b)) {
          collides = true;
          break outer;
        }
      }
    }
    if (collides) {
      overlaps.push({ path, block_ids: owners });
    }
  }
  // Deterministic ordering so the diagnostic + tests are stable.
  return overlaps.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * True when any hunk in `a` shares a new-side line with any hunk in `b`. Each
 * hunk spans `[startLine, startLine + lineCount - 1]`; a zero-line hunk (pure
 * deletion at `startLine`) is treated as touching the single anchor line
 * `startLine` so a deletion adjacent to another block's insertion is still a
 * conflict. Purely non-overlapping ranges (e.g. lines 1–5 vs 40–50) return
 * false → the two edits are disjoint and compose cleanly.
 */
function hunkRangesOverlap(a: GitBranchHunk[], b: GitBranchHunk[]): boolean {
  const span = (h: GitBranchHunk): [number, number] => {
    const count = h.lineCount > 0 ? h.lineCount : 1;
    return [h.startLine, h.startLine + count - 1];
  };
  for (const ha of a) {
    const [aStart, aEnd] = span(ha);
    for (const hb of b) {
      const [bStart, bEnd] = span(hb);
      if (aStart <= bEnd && bStart <= aEnd) return true;
    }
  }
  return false;
}
