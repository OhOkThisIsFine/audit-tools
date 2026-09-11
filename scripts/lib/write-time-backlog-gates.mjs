// The backlog gates that run AT WRITE TIME, and the one thing that differs
// between their write-time and commit-time verdicts.
//
// WHY. `docs/backlog/` is the one corpus whose gates were reachable only at
// commit, and a backlog entry is written in one session and landed in another:
// nine entries hit `check:doc-code-citations` (13 unresolved backticked paths)
// and then, on a later attempt, `check:backlog-line-numbers` (3 `path:line`
// forms) as a serialized gate-fix-retry loop — against text nobody present had
// authored, in a session that no longer held the sources the citations named.
//
// APPLIED AT THE EDIT, NOT AT THE COMMIT. So this is not a second gate set: the
// ids come from the ONE guard registry (`scripts/guard-reach-data.mjs`), through
// the same derived-leg builder the commit gate uses, and every triggered leg runs
// (so one edit surfaces every refusal it caused, rather than one per retry). The
// write-time path is reached through `buildWriteTimeLegs` in
// `scripts/shared/derived-file-preflight.mjs`; the commit path through
// `buildPreCommitLegs`. When a gate's reach, maxMs, or fix hint changes, both draws
// move together — writing that call site and its ordering down is the whole reason
// this module is a module.
//
// ── THE ONE DIVERGENCE, and why it is not a loophole ────────────────────────
// `--update-baseline` REWRITES the baseline. It is the remedy for a shrink, and it
// deletes any baseline key that no longer applies — so an edit that makes a recorded
// ceiling stale (the file dropped back under the budget) would be auto-cleared by
// running it, from the write-time path, on a tree nobody meant to commit. The
// baseline is therefore LAP-SCOPED state: write time reports the refusal as advice
// and skips the leg, and the commit gate runs it as the authority, exactly as before.
// Read the other way round — the refusal is not suppressed, it is DEFERRED, and the
// deferral is announced rather than silent.
//
// The exception is conservative in the only direction that matters: `--update-baseline`
// cannot RAISE a recorded ceiling without `--raise-ceiling` (see
// `planBaselineUpdate` in scripts/check-backlog-budget.mjs), so deferring the budget
// leg cannot let a grown file's ceiling be laundered upward at write time.
export const WRITE_TIME_DEFERRED_LEGS = new Set(["check:backlog-budget"]);

/** The one-line note printed for a deferred leg, in place of its output. */
export const DEFERRAL_NOTE =
  "the size baseline RATCHETS only at commit — its remedy `--update-baseline` rewrites " +
  "docs/backlog/.size-baseline.json, so an edit that merely makes a recorded ceiling stale " +
  "would clear it from an uncommitted tree. The commit gate runs this leg as the authority.";

/**
 * Draw the write-time backlog advisories for one edited path.
 *
 * @param {{legs: {id: string, script: string, maxMs: number, fix: string}[], root: string,
 *   execute: Function, legRunnable: Function, legCommand: Function}} input
 *   `legs` is the registry-derived draw (buildWriteTimeLegs), already filtered to
 *   reach the edited path; the four callables are injected so a test can drive the
 *   whole selection in a fixture repo with no npm and no gates on disk.
 * @returns {{findings: {id: string, script: string, fix: string, tail: string}[],
 *   ran: string[], deferred: string[], skipped: string[]}}
 */
export function runBacklogWriteTimeGates({ legs, root, execute, legRunnable, legCommand }) {
  const findings = [];
  const ran = [];
  const deferred = [];
  const skipped = [];
  for (const leg of legs) {
    if (WRITE_TIME_DEFERRED_LEGS.has(leg.id)) {
      deferred.push(leg.id);
      continue;
    }
    if (!legRunnable(root, leg)) {
      skipped.push(`${leg.script} is not wired in this repo`);
      continue;
    }
    try {
      execute(legCommand(leg).command, {
        cwd: root,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: leg.maxMs,
        windowsHide: true,
      });
      ran.push(leg.id);
    } catch (error) {
      const err = /** @type {any} */ (error);
      const tail = `${err?.stdout ?? ""}\n${err?.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
      findings.push({ id: leg.id, script: leg.script, fix: leg.fix, tail });
    }
  }
  return { findings, ran, deferred, skipped };
}
