// Live-work predicate for Stop-hook payloads — shared by the session-lifecycle
// Stop gates (closeout-challenge, friction-stop) so both read ONE definition of
// "this stop is a wait, not an end".
//
// Empirical basis (probed live 2026-08-07, Claude Code 2.1.222, win32): the Stop
// payload carries `background_tasks` — the session's live task set — e.g.
//   { id, type: "shell",    status: "running", description, command }
//   { id, type: "subagent", status: "running", description, agent_type }
// and entries LEAVE the array once their completion is harvested (a
// post-completion Stop probed as []). `session_crons` (same build) lists the
// session's scheduled wakeups. Older builds omit both fields, which makes this
// predicate false and the consuming gates behave exactly as before the fields
// existed — absence degrades to the pre-signal behavior, never to a wedge.
//
// Failure direction is deliberate: an entry with an unknown or missing status
// counts as LIVE, and task `type` is ignored (subagents, workflows and shell
// tasks all mean the harness will re-invoke the session). For both consumers
// the cheap failure is a skipped intervention at a turn boundary; the expensive
// one is spending a capped challenge — or forcing a friction walk — on a stop
// the harness is about to resume anyway.

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped']);

/**
 * True when a Stop payload shows the session still has live harness-tracked
 * work — background tasks not yet terminal, or scheduled session crons — i.e.
 * this stop is a turn boundary the harness will resume, not a closeout.
 *
 * @param {unknown} payload parsed Stop-hook stdin payload
 * @returns {boolean}
 */
export function sessionHasLiveBackgroundWork(payload) {
  const p = /** @type {{ background_tasks?: unknown; session_crons?: unknown }} */ (payload ?? {});
  if (Array.isArray(p.background_tasks)) {
    for (const task of p.background_tasks) {
      const status =
        typeof (/** @type {{ status?: unknown }} */ (task)?.status) === 'string'
          ? /** @type {{ status: string }} */ (task).status
          : '';
      if (!TERMINAL_TASK_STATUSES.has(status)) return true;
    }
  }
  return Array.isArray(p.session_crons) && p.session_crons.length > 0;
}
