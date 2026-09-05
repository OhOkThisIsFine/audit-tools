// One-item-per-call lane dispatch driver (P28 wrapper half, nightly sol-3).
//
// Extracted from scripts/shared/triage-backlog.mjs, which grew the correct
// shape once: bounded items, ONE lane call per item (never "the whole file in
// one prompt"), per-item log redirect, finish reason + output size recorded on
// every row the lane produced, and a coverage stamp beside the output so "did
// the sweep cover the input" is a number a routine reads, never a wc -l.
//
// LANE-AGNOSTIC BY CONSTRUCTION. A lane is any `async (item) => ({ raw,
// finishReason?, ...meta })` — the sole live caller posts to an HTTP router,
// and a shell lane (peer-CLI dispatch: `codex exec` / `agy -p` one item at a
// time) is the intended SECOND adapter, deliberately not shipped until its
// first caller migrates (an unconsumed adapter is the tested-but-unwired
// dead-code class this repo prunes). The driver imposes no transport policy:
// no retry (failover is the lane's/router's job), no finish-reason semantics
// (`finish_reason !== 'stop'` is OpenAI chat policy and belongs in the
// caller's buildRecord), no model choice.
//
// COVERAGE STAMP IS A READ-VERBATIM CONTRACT. docs/nightly-routine.md reads
// `<out>-coverage.json` by these exact field names: model, started_at,
// finished_at, aborted, total_entries, prior_classified, attempted,
// classified, classified_total, errored (+ caller counters via `stampInit`).
// `classified` is triage-flavored but renaming a persisted field is not a
// rename — keep the names. [[renaming-a-persisted-field-is-not-a-rename]]
//
// IMPORT-SAFE AND EXIT-FREE: this module never calls process.exit — an abort
// is a write (stamp) plus a typed throw (LanePreflightError); the exit lives
// in whichever CLI shell owns the process.
import fs from 'node:fs';

/** `<out minus .jsonl>-coverage.json` — the coverage stamp sidecar. */
export function coverageStampPath(outPath) {
  return outPath.replace(/\.jsonl$/, '') + '-coverage.json';
}

export function writeCoverageStamp(path, stamp) {
  fs.writeFileSync(path, JSON.stringify(stamp, null, 2) + '\n');
}

/** Preflight failed: the lane is DEAD, not slow — nothing was attempted. */
export class LanePreflightError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LanePreflightError';
  }
}

/**
 * Drive a bounded sweep: one lane call per item, resumable, stamped.
 *
 * @param {object} opts
 * @param {Array<Record<string, any>>} opts.items bounded units, each with a
 *   stable content-derived `id` (resume identity). An item's `file` (when
 *   present) is echoed onto its error rows so a reader can still tell what the
 *   row was about when the lane never produced a record.
 * @param {string} opts.outPath JSONL output; exactly one record appended per
 *   item. The coverage stamp lands beside it (`coverageStampPath`).
 * @param {(item: any) => Promise<{raw: string, finishReason?: string}>} opts.callLane
 *   ONE call for ONE item. May throw (transport death → error row); must never
 *   retry internally — failover belongs to the lane.
 * @param {(item: any, laneResult: any) => any} opts.buildRecord
 *   parse/validate/enrich the lane result into the persisted record; a throw
 *   lands the item as an error row (and, since the lane DID answer, that row
 *   still carries finish_reason/output_bytes — the P28 diagnostic axis:
 *   near-zero output is dialect death, large-but-truncated is a cap to raise).
 * @param {(rec: any) => any} [opts.reviveRecord] applied to every kept
 *   row on resume load; the rewritten file carries the revived shape (running
 *   the sweep IS the presentation event for its records).
 * @param {() => Promise<void>} [opts.preflight] one cheap call before the
 *   sweep, SINGLE attempt: a dead lane must fail loudly at item 0 — aborted
 *   stamp written, LanePreflightError thrown, callLane never invoked.
 * @param {number} [opts.concurrency]
 * @param {(item: any) => string} [opts.itemLogPath] per-item log redirect:
 *   the raw lane output is written there BEFORE buildRecord runs, so a
 *   parse-dead item still leaves its evidence on disk.
 * @param {Record<string, any>} [opts.stampSeed] caller facts leading the stamp
 *   (e.g. `{ model }` — resolution stays caller-side; the driver never picks one).
 * @param {Record<string, any>} [opts.stampInit] caller counters appended to
 *   the stamp (e.g. `{ probes_unusable: 0 }`), maintained via `stampExtra`.
 * @param {(stamp: any, rec: any) => void} [opts.stampExtra] per-record
 *   hook mutating the caller's own stamp counters.
 * @param {(item: any, rec: any) => void} [opts.onProgress] fires after
 *   the record is appended and the stamp rewritten.
 * @returns {Promise<{stamp: Record<string, any>, records: Array<Record<string, any>>}>}
 *   records = this run's appended rows, in completion order.
 */
export async function dispatchBoundedItems({
  items,
  outPath,
  callLane,
  buildRecord,
  reviveRecord,
  preflight,
  concurrency = 3,
  itemLogPath,
  stampSeed = {},
  stampInit = {},
  stampExtra,
  onProgress,
}) {
  const stampPath = coverageStampPath(outPath);
  // Best-effort telemetry: a failed stamp write (missing dir, locked file) must
  // never mask the real abort message or kill a healthy sweep.
  let stampWarned = false;
  const stampSafe = (data) => {
    try {
      writeCoverageStamp(stampPath, data);
    } catch (err) {
      if (!stampWarned) {
        stampWarned = true;
        process.stderr.write(`coverage stamp not writable (${/** @type {any} */ (err)?.message ?? err}) — continuing without it\n`);
      }
    }
  };

  // Resume: completed ids are read back from the JSONL and skipped, so a
  // killed run continues rather than restarting. Errored rows are DROPPED and
  // their items re-queued: an id in `done` means a verdict exists, never that
  // an attempt happened. (The old behaviour added errored ids too, so a re-run
  // retried nothing and exited 0 — a false green.) Kept rows pass through
  // `reviveRecord` so the rewritten file reflects the tree as of THIS run.
  const done = new Set();
  if (fs.existsSync(outPath)) {
    const kept = [];
    for (const l of fs.readFileSync(outPath, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        const rec = JSON.parse(l);
        if (rec.error) continue;
        done.add(rec.id);
        kept.push(reviveRecord ? reviveRecord(rec) : rec);
      } catch {}
    }
    fs.writeFileSync(outPath, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  }

  const queue = items.filter((e) => !done.has(e.id));
  const stamp = {
    ...stampSeed,
    started_at: new Date().toISOString(),
    finished_at: null,
    aborted: null,
    total_entries: items.length,
    prior_classified: done.size,
    attempted: 0,
    classified: 0,
    classified_total: done.size,
    errored: 0,
    ...stampInit,
  };
  stampSafe(stamp);

  // Preflight: one call before the sweep, SINGLE attempt (matching the
  // per-item no-retry policy — failover is the lane's job). A dead lane must
  // fail loudly at item 0, with the lane's own message, not silently at
  // item 154.
  if (preflight) {
    try {
      await preflight();
    } catch (err) {
      stamp.aborted = /** @type {any} */ (`preflight failed: ${String(/** @type {any} */ (err).message || err)}`);
      stampSafe(stamp);
      throw new LanePreflightError(stamp.aborted, { cause: err });
    }
  }

  const records = [];
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const e = queue[cursor++];
      let rec;
      let laneAnswered = false;
      let finishReason;
      let outputBytes;
      try {
        const laneResult = await callLane(e);
        laneAnswered = true;
        const raw = typeof laneResult?.raw === 'string' ? laneResult.raw : String(laneResult?.raw ?? '');
        finishReason = laneResult?.finishReason;
        outputBytes = Buffer.byteLength(raw, 'utf8');
        // Per-item log redirect BEFORE parsing: a record buildRecord rejects
        // still leaves the raw output on disk for diagnosis.
        if (itemLogPath) fs.writeFileSync(itemLogPath(e), raw);
        rec = buildRecord(e, laneResult);
      } catch (err) {
        rec = {
          id: e.id,
          ...(typeof e.file === 'string' ? { file: e.file } : {}),
          error: String(/** @type {any} */ (err).message || err),
        };
      }
      if (laneAnswered) {
        // Driver-owned facts about what the LANE did — never the payload's to
        // state, and recorded on error rows too (the P28 diagnostic axis).
        rec.finish_reason = finishReason;
        rec.output_bytes = outputBytes;
      }
      stamp.attempted += 1;
      if (rec.error) stamp.errored += 1;
      else stamp.classified += 1;
      // Cumulative, because the per-pass `classified` reads as near-total
      // failure after a retry pass (a 2-entry retry stamped "classified: 2"
      // while true coverage was 120) and the routine's contract reads the
      // stamp verbatim.
      stamp.classified_total = stamp.prior_classified + stamp.classified;
      if (stampExtra) stampExtra(stamp, rec);
      // Rewritten per completion (cheap, atomic-enough for a progress sidecar):
      // a killed run leaves an honest partial stamp, not silence.
      stampSafe(stamp);
      fs.appendFileSync(outPath, JSON.stringify(rec) + '\n');
      records.push(rec);
      if (onProgress) onProgress(e, rec);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  stamp.finished_at = /** @type {any} */ (new Date().toISOString());
  stampSafe(stamp);
  return { stamp, records };
}
