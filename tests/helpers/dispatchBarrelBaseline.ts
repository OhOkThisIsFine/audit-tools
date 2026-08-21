/**
 * The COMMITTED baseline of `src/remediate/steps/dispatch.ts`'s value-export
 * surface, updated only by a deliberate edit and never derived at run time.
 * A baseline that re-derives from the thing it guards cannot detect that thing
 * changing. Single-sourced here because two suites pin the same surface.
 */
export const DISPATCH_BARREL_EXPORTS = [
  "ingestRemediationHostResults",
  "prepareRemediationHostHandoff",
  "readExtractedPlanIfPresent",
  "remediationHostResultFilePath",
] as const;
