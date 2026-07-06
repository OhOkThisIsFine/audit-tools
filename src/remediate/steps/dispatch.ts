// ---------------------------------------------------------------------------
// dispatch.ts — thin barrel
//
// The implementation was split into cohesive sibling modules under
// `./dispatch/` (CP-NODE-7). This file re-exports the EXACT original public
// surface so every consumer that imports from `steps/dispatch.js` keeps working
// unchanged. New code may import directly from the submodules; the barrel is the
// backwards-compatible aggregate.
// ---------------------------------------------------------------------------

// --- common (paths, git primitives, git-diff resolution, token estimation, conventions cache) ---
export type {
  DispatchOptions,
  GitEditedFiles,
  GitBranchHunk,
  GitBranchHunks,
} from "./dispatch/common.js";
export {
  gitTopLevel,
  worktreeBranchForBlock,
  gitEditedFilesForBranch,
  gitHunksForBranch,
  parseUnifiedDiffHunks,
  writeScopeViolations,
  detectRepoConventionsCache,
} from "./dispatch/common.js";

// --- DAG-node field accessors ---
export type { DagNodeFields } from "./dispatch/dagNodeFields.js";

// --- wave scheduling / quota ---
export type { HostConcurrencyLimit } from "audit-tools/shared";
export {
  resolveHostActiveSubagentLimit,
  detectHostConcurrencyFromEnv,
  normalizeSlotTokens,
  resolveHostConcurrencyLimit,
  scheduleWave,
  buildConfirmedPools,
  buildDispatchQuota,
} from "./dispatch/waveScheduling.js";
export type {
  ScheduleWaveInput,
  WaveScheduleResult,
} from "./dispatch/waveScheduling.js";

// --- worktree lifecycle ---
export type { WorktreeVerifyResult } from "./dispatch/worktreeLifecycle.js";
export {
  createWorktree,
  seedUntrackedDeclaredPaths,
  removeWorktree,
  resetNodeWorktreeAndBranch,
  verifyNodeInWorktree,
  mergeWorktree,
  dirtyMainTreeCollisions,
  rebaseBranchOntoHead,
  worktreePath,
  remediationBranchName,
  baseBranchLockPath,
  quarantineRef,
  quarantineFailedNodeCommit,
  quarantineUncommittedWorktreeEdits,
  clearQuarantinedCommit,
  listQuarantinedCommits,
  remediationBaseBranchPath,
  readRemediationBaseBranch,
  ensureRemediationBranchCheckedOut,
  commitWorktree,
  ensureWorktreeNodeModules,
} from "./dispatch/worktreeLifecycle.js";

// --- accept-node lifecycle ---
export type {
  NodeWorkerOutcome,
  AcceptNodeWorktreeParams,
  AcceptNodeWorktreeResult,
  WorktreeNodeWorker,
  NodeWorktreeExecution,
} from "./dispatch/acceptNode.js";
export {
  acceptNodeWorktree,
  nodeAcceptOutcomePath,
  recordNodeAcceptOutcome,
  loadNodeAcceptOutcome,
  executeNodeInWorktree,
} from "./dispatch/acceptNode.js";

// --- verify commands ---
export {
  isBuildFreeVerifyCommand,
  normalizeNodeTestCommand,
  isWholeSuiteTestCommand,
  pathTokensInCommand,
  selfContainedVerifyCommands,
  verifyCommandsForEdits,
  deriveVerifyCommandsFromBranch,
  targetedCommandsForBlock,
} from "./dispatch/verifyCommands.js";

// --- implement prompt / model hint / test index / infra detection ---
export type { TestFileEntry } from "./dispatch/implementPrompt.js";
export {
  buildImplementModelHint,
  implementResultPath,
  isInfraModifyingBlock,
  buildTestFileIndex,
  collectReferencingTests,
} from "./dispatch/implementPrompt.js";

// --- write-scope + merge-seam ---
export type {
  WriteScopeDecision,
  NodeDispositionStatus,
  NodeDisposition,
  BlockEditedFiles,
  OverlappingEdit,
} from "./dispatch/writeScope.js";
export {
  enforceWriteScope,
  blockScopesFromPlan,
  declaredPathsFromPlan,
  adjudicateWriteScope,
  enforceAcceptWriteScope,
  buildBlockAliasMap,
  collapseItemResults,
  buildNodeDisposition,
  attributeSiblingRed,
  detectOverlappingEdits,
} from "./dispatch/writeScope.js";

// --- marshalling (prepare / merge / readers) ---
export {
  prepareImplementDispatch,
  mergeImplementResults,
  readExtractedPlanIfPresent,
  readDispatchPlan,
} from "./dispatch/marshal.js";
