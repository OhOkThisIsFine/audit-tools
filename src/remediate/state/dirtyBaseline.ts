// sites-pinned: tests/remediate/dirty-baseline-authority.test.ts
/** Historical pre-edit authority. Reading legacy state never mints this authority. */
export class RemediationDirtyBaselineError extends Error {
  constructor() {
    super("The pre-edit dirty baseline is unavailable or unsupported; existing work is preserved; a fresh authorized run is required.");
    this.name = "RemediationDirtyBaselineError";
  }
}

/** Return the original exact ordered paths; never repair or recapture history. */
export function admitRemediationDirtyBaseline(state: {
  readonly run_start_dirty?: unknown;
  readonly run_start_dirty_encoding?: unknown;
}): readonly string[] {
  if (state.run_start_dirty_encoding !== "git-z/v1" ||
      !Array.isArray(state.run_start_dirty) ||
      !Array.from(state.run_start_dirty).every((path: unknown) => typeof path === "string")) {
    throw new RemediationDirtyBaselineError();
  }
  return state.run_start_dirty as readonly string[];
}
