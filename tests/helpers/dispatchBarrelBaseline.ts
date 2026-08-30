/**
 * The COMMITTED baseline of `src/remediate/steps/dispatch/hostHandoff.ts`'s
 * value-export surface, updated only by a deliberate edit and never derived at
 * run time. A baseline that re-derives from the thing it guards cannot detect
 * that thing changing. Single-sourced here because two suites pin the same
 * surface. (Until CY-03 this pinned the `steps/dispatch.ts` re-export barrel;
 * the barrel was deleted and the mocks now target this module directly, so the
 * mock-blanking failure mode the pin exists for lives here.)
 */
export const DISPATCH_BARREL_EXPORTS = [
  "REMEDIATION_ISSUE_CODES",
  "hostDependencyLevels",
  "ingestRemediationHostResults",
  "permanentlyDeadPendingBlocks",
  "precomputeRecoveryTestVerdicts",
  "prepareRemediationHostHandoff",
  "remediationHostResultFilePath",
  "remediationSubmissionBinding",
  "runRequiredTest",
] as const;
