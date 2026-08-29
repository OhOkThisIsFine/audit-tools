// Live-work predicate for Stop-hook payloads — shared by the session-lifecycle
// Stop gates (closeout-challenge, friction-stop) so both read ONE definition of
// "this stop is a wait, not an end".
//
// Empirical basis (probed live 2026-08-07, Claude Code 2.1.222, win32; re-probed
// 2026-08-29, CC 2.1.247): the Stop payload carries `background_tasks` — the
// session's live task set — e.g.
//   { id, type: "shell",    status: "running", description, command }
//   { id, type: "subagent", status: "running", description, agent_type }
// and entries LEAVE the array once the task PROCESS EXITS — not once its
// notification is harvested (measured 2026-08-29: a post-exit, pre-harvest Stop
// probed as `[]` while the harness held the queued task-notification it
// delivered seconds later). That window is what `pendingQueuedResume` covers:
// the transcript's `queue-operation` depth is positive exactly while queued
// input the harness WILL deliver is outstanding, so that stop is a wait too.
// Diagnosis + measured payload shapes:
// docs/reviews/closeout-gate-queued-resume-2026-08-29.md.
// `session_crons` (same builds) lists the session's scheduled wakeups. Older
// builds omit these fields, which makes this predicate false and the consuming
// gates behave exactly as before the fields existed — absence degrades to the
// pre-signal behavior, never to a wedge.
//
// Failure direction is deliberate: an entry with an unknown or missing status
// counts as LIVE, task `type` is ignored (subagents, workflows and shell tasks
// all mean the harness will re-invoke the session), and every leg suppresses
// only on POSITIVE evidence — a missing, empty, or unreadable signal never
// reads as "live", so no leg can invert absence into a skipped challenge. For
// both consumers the cheap failure is a skipped intervention at a turn
// boundary; the expensive one is spending a capped challenge — or forcing a
// friction walk — on a stop the harness is about to resume anyway.

import { readFileSync } from 'node:fs';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped']);

/**
 * True when the transcript shows queued session input the harness has not yet
 * delivered — an enqueued task-notification (or prompt) without its matching
 * dequeue/remove — i.e. the harness WILL resume this session, so the current
 * stop is a wait even though `background_tasks` is already empty.
 *
 * A DEPTH COUNTER, not id-matching, because the harness's `dequeue` records
 * carry no content and no task-id (measured 2026-08-29) — only `enqueue` and
 * `remove` do. Known uncovered halves (stated, not hidden):
 *   - flush race: an enqueue not yet on disk at the Stop reads as depth 0 and
 *     the gate fires exactly as it does today;
 *   - stuck-positive depth: an enqueue whose dequeue/remove never lands
 *     suppresses for the rest of the session — the cheap failure direction;
 *   - kind-agnostic: a queued USER prompt suppresses too, which is correct for
 *     "will the harness resume" and indistinguishable anyway.
 *
 * @param {unknown} transcriptPath the Stop payload's `transcript_path`
 * @returns {boolean}
 */
export function pendingQueuedResume(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return false;
  let depth = 0;
  try {
    for (const line of readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'queue-operation') continue;
      depth = entry.operation === 'enqueue' ? depth + 1 : Math.max(0, depth - 1);
    }
  } catch {
    return false; // unreadable transcript → no evidence → the gates fire as today
  }
  return depth > 0;
}

/**
 * WHY this stop is a wait, or null when nothing says so — the single
 * definition both the boolean predicate and the gates' debug skip-logs read,
 * so the reason vocabulary cannot fork from the decision.
 *
 * @param {unknown} payload parsed Stop-hook stdin payload
 * @returns {'live_background_task' | 'session_cron' | 'queued_resume' | null}
 */
export function liveSessionWorkReason(payload) {
  const p =
    /** @type {{ background_tasks?: unknown; session_crons?: unknown; transcript_path?: unknown }} */ (
      payload ?? {}
    );
  if (Array.isArray(p.background_tasks)) {
    for (const task of p.background_tasks) {
      const status =
        typeof (/** @type {{ status?: unknown }} */ (task)?.status) === 'string'
          ? /** @type {{ status: string }} */ (task).status
          : '';
      if (!TERMINAL_TASK_STATUSES.has(status)) return 'live_background_task';
    }
  }
  if (Array.isArray(p.session_crons) && p.session_crons.length > 0) return 'session_cron';
  if (pendingQueuedResume(p.transcript_path)) return 'queued_resume';
  return null;
}

/**
 * True when a Stop payload shows the session still has live harness-tracked
 * work — background tasks not yet terminal, scheduled session crons, or queued
 * input awaiting delivery — i.e. this stop is a turn boundary the harness will
 * resume, not a closeout.
 *
 * @param {unknown} payload parsed Stop-hook stdin payload
 * @returns {boolean}
 */
export function sessionHasLiveBackgroundWork(payload) {
  return liveSessionWorkReason(payload) !== null;
}
