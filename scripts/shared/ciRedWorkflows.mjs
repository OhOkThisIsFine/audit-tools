// Which workflows are RED on a branch right now — the pure half, so the closeout
// gate's network call and its verdict can be tested apart.
//
// `main` sat red for ~a dozen laps while every lap reported "green", and it
// happened again on 2026-07-25: `ci` was green across three commits while
// `audit-code-test-suite` — the only workflow that runs vitest — failed. Reading
// ONE workflow is not reading CI, and "remember to check" is the fix this project
// bans. So the check is mechanical and the verdict lives here.
//
// Two rules the raw run list will fool you on:
//   • Only the MOST RECENT completed run per workflow counts. An older failure
//     that a later run turned green is history, not a red main.
//   • `cancelled` is NOT a failure. A newer push cancels the older run by
//     concurrency, which is routine; treating it as red trains the override into
//     a reflex (same reasoning as the constitutional gate's narrowness).

/**
 * Names of workflows whose most recent COMPLETED run concluded in failure.
 *
 * @param {Array<{workflowName?: string | null, status?: string | null, conclusion?: string | null, createdAt?: string | null} | null | undefined> | null | undefined} runs
 *   Runs for one branch, any order — as returned by
 *   `gh run list --json workflowName,status,conclusion,createdAt`. Nullable
 *   throughout: the implementation degrades junk input to "cannot tell" ([])
 *   rather than throwing, and the type states that real contract.
 * @returns {string[]} Failing workflow names, sorted, de-duplicated.
 */
export function latestFailedWorkflows(runs) {
  if (!Array.isArray(runs)) return [];

  /** @type {Map<string, {createdAt: number, conclusion: string}>} */
  const newestCompleted = new Map();

  for (const run of runs) {
    if (run === null || typeof run !== 'object') continue;
    const name = typeof run.workflowName === 'string' ? run.workflowName : '';
    if (!name) continue;
    // An in-flight run is not a verdict — it neither reds nor clears a workflow.
    if (run.status !== 'completed') continue;
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : '';
    if (!conclusion) continue;
    // A superseded run is routine, and carries no signal either way.
    if (conclusion === 'cancelled') continue;

    // An unparseable timestamp must not sort as "newest" (NaN comparisons are
    // false, so it would silently lose every comparison instead).
    const createdAt = Date.parse(String(run.createdAt ?? ''));
    if (!Number.isFinite(createdAt)) continue;

    const seen = newestCompleted.get(name);
    if (seen === undefined || createdAt > seen.createdAt) {
      newestCompleted.set(name, { createdAt, conclusion });
    }
  }

  return [...newestCompleted.entries()]
    .filter(([, v]) => v.conclusion === 'failure')
    .map(([name]) => name)
    .sort();
}
