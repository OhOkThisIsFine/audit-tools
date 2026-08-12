import {
  toRepoRelative,
  writeScopeViolations,
  gitEditedFilesForBranch,
  type GitEditedFiles,
} from "./common.js";

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

/**
 * Pure write-scope adjudication (OBL-DS-06) — git-free so it is unit-testable with
 * a synthetic edit set. It normalizes the complete declared-scope snapshot and
 * checks the node's ACTUAL edits — git ground truth, never a self-report:
 *  - an edit to a file no sibling block owns widens this node's effective scope;
 *    effective scope (a too-narrow — or empty — declared scope no longer blocks a
 *    correct fix; this is the sanctioned "extend into unowned files" path);
 *  - an edit to a file in another block's declared scope is a seam conflict that
 *    blocks until the host re-scopes or serializes the work.
 */
export function adjudicateWriteScope(
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>,
  blockId: string,
  edited: GitEditedFiles,
  root: string,
): WriteScopeDecision {
  const normalizedScopes = allBlockScopes.map((scope) => ({
    blockId: scope.block_id,
    paths: scope.write_paths.map((path) => toRepoRelative(path, root)),
  }));
  const effectiveScope = new Set(
    normalizedScopes.find((scope) => scope.blockId === blockId)?.paths ?? [],
  );
  if (!edited.available) return enforceWriteScope([...effectiveScope], edited, root);

  const candidates = writeScopeViolations([...effectiveScope], edited.files, root);
  const conflicts: string[] = [];
  for (const candidate of candidates) {
    const owners = normalizedScopes
      .filter(
        (scope) => scope.blockId !== blockId && scope.paths.includes(candidate),
      )
      .map((scope) => scope.blockId)
      .sort();
    if (owners.length > 0) {
      conflicts.push(`${candidate} owned by ${owners.join(", ")}`);
    } else {
      effectiveScope.add(candidate);
    }
  }
  if (conflicts.length > 0) {
    return {
      blocked: true,
      reason:
        `Node edited files owned by another block (seam conflict): ${conflicts.join("; ")}. ` +
        `Re-scope or serialize the work before this result can be accepted.`,
    };
  }
  return enforceWriteScope([...effectiveScope], edited, root);
}

/**
 * Git-backed write-scope gate. Thin wrapper around
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
