// ---------------------------------------------------------------------------
// dispatch.ts — thin barrel
//
// The implementation was split into cohesive sibling modules under
// `./dispatch/` (CP-NODE-7). This file re-exports the EXACT original public
// surface so every consumer that imports from `steps/dispatch.js` keeps working
// unchanged. New code may import directly from the submodules; the barrel is the
// backwards-compatible aggregate.
// ---------------------------------------------------------------------------

// --- common (paths, git primitives, git-diff resolution) ---
export type {
  DispatchOptions,
  GitEditedFiles,
  GitBranchHunk,
  GitBranchHunks,
} from "./dispatch/common.js";
export {
  gitTopLevel,
  isOwnGitTopLevel,
  worktreeBranchForBlock,
  gitEditedFilesForBranch,
  gitHunksForBranch,
  gitCommitIsAncestor,
  gitBranchExists,
  parseUnifiedDiffHunks,
  writeScopeViolations,
} from "./dispatch/common.js";

// --- DAG-node metadata overlay shape ---
export type { DagNodeFields } from "./dispatch/dagNodeFields.js";

// --- verify commands ---
export {
  isBuildFreeVerifyCommand,
  normalizeNodeTestCommand,
  isWholeSuiteTestCommand,
  isDistDependentVerifyCommand,
  isWorktreeHostileVerifyCommand,
  partitionDeferredVerifyCommands,
  dedupeDeferredVerifyCommands,
  pathTokensInCommand,
  selfContainedVerifyCommands,
  verifyCommandsForEdits,
  deriveVerifyCommandsFromBranch,
  targetedCommandsForBlock,
} from "./dispatch/verifyCommands.js";

// --- implement prompt / test index / infra detection ---
export type { TestFileEntry } from "./dispatch/implementPrompt.js";
export {
  isInfraModifyingBlock,
  buildTestFileIndex,
  collectReferencingTests,
} from "./dispatch/implementPrompt.js";

// --- write-scope corroboration ---
export type { WriteScopeDecision } from "./dispatch/writeScope.js";
export {
  enforceWriteScope,
  adjudicateWriteScope,
  enforceAcceptWriteScope,
} from "./dispatch/writeScope.js";

// --- planning-pipeline handoff reader ---
export { readExtractedPlanIfPresent } from "./dispatch/marshal.js";

// --- provider-neutral host workload / result-ingestion boundary ---
export type {
  CurrentRemediationHostState,
  PreparedRemediationHostHandoff,
  RemediationHostIngestSummary,
  RemediationHostWorkItem,
  RemediationHostWorkload,
  UnsupportedRetiredRemediationState,
} from "./dispatch/hostHandoff.js";
export {
  ingestRemediationHostResults,
  prepareRemediationHostHandoff,
  remediationHostResultFilePath,
} from "./dispatch/hostHandoff.js";
