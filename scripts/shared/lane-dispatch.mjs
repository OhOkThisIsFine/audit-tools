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
// no failover (which RUNG answers is the lane's/router's job), no finish-reason
// semantics (`finish_reason !== 'stop'` is OpenAI chat policy and belongs in the
// caller's buildRecord), no model choice.
//
// ── THE ONE RETRY, and the line it is drawn on ───────────────────────────────
// The driver DOES retry, once per item, and only on a TRANSPORT-level failure —
// a call that threw before the lane answered at all. That is the 2026-08-22
// sweep: 22 of 96 entries errored in one pass, a plain re-run recovered 20 of the
// 22, and the operator had to know to run it again — a documented recovery, and
// therefore one nobody is obliged to remember, which is exactly the class this
// repo refuses to leave to memory. A run that stops after one pass writes a
// coverage stamp reporting 74/96 as if that were the ceiling.
//
// WHAT IS NOT RETRIED, deliberately, and this is the whole reason the retry is
// here and not in the caller: a lane that ANSWERED and produced an unusable
// payload. That answer is the lane's verdict on itself — a different rung may
// answer better, and picking one is the relay's job, so retrying the same way
// would burn a second full-timeout attempt to relearn the same dialect death.
// The line is `callLane` threw vs. `buildRecord` threw: a throw from the LATTER
// means the lane spoke, so the item lands as an error row immediately.
//
// The bound is stated rather than tuned: ONE retry per item, within one
// invocation. More would multiply the 20-minute ceiling by the attempt count and
// turn one dead entry into an hour of a nightly leg.
//
// COVERAGE STAMP IS A READ-VERBATIM CONTRACT. docs/nightly-routine.md reads
// `<out>-coverage.json` by these exact field names: model, started_at,
// finished_at, aborted, total_entries, prior_classified, attempted,
// classified, classified_total, errored, retried (+ caller counters via
// `stampInit`). `classified` is triage-flavored but renaming a persisted field
// is not a rename — keep the names.
// [[renaming-a-persisted-field-is-not-a-rename]]
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
 *   ONE call for ONE item. May throw (transport death → one driver retry, then
 *   an error row); must never retry internally — which rung answers belongs to
 *   the lane.
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
    // Driver-owned, like `attempted`/`errored`, and declared in the literal so
    // the read-verbatim contract names it from the first write: the sweep
    // retrying its own transport failures is the 2026-08-22 entry's property, so
    // the stamp must show how much coverage came from a second attempt rather
    // than hiding it behind an unchanged classified count.
    retried: 0,
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
  let retried = 0;

  /**
   * The ERROR ROW shape for one item — same identity echo on every path.
   * @returns {{id: any, file?: any, error: string, retry?: {attempts: number, errors: string[]}}}
   */
  const errorRow = (e, err) => ({
    id: e.id,
    ...(typeof e.file === 'string' ? { file: e.file } : {}),
    error: String(/** @type {any} */ (err).message || err),
  });

  /**
   * ONE call, and on a TRANSPORT throw exactly ONE more — see the header's "THE
   * ONE RETRY". Returns the row plus whether the lane answered, so the caller
   * still stamps the driver-owned diagnostic on a row the lane produced.
   *
   * The first attempt's message is preserved on the row (`retry.errors`) rather
   * than discarded: if the retry succeeds, the fact that the first call died is
   * the only evidence of a flaky transport, and it is exactly what a reader
   * diagnosing a partial sweep needs. Discarding it would make a recovered
   * transport death indistinguishable from a clean pass.
   */
  async function attempt(e) {
    const failures = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const laneResult = await callLane(e);
        return { laneResult, laneAnswered: true, failures };
      } catch (err) {
        failures.push(String(/** @type {any} */ (err).message || err));
        // A SECOND failure is terminal for this item, and only the first
        // attempt may be retried — the bound is one, stated in the header.
        if (attempt === 2) return { laneResult: null, laneAnswered: false, failures };
        retried += 1;
      }
    }
    // Unreachable: the loop returns on both the success and the terminal path.
    return { laneResult: null, laneAnswered: false, failures };
  }

  async function worker() {
    while (cursor < queue.length) {
      const e = queue[cursor++];
      let rec;
      let laneAnswered = false;
      let finishReason;
      let outputBytes;
      const { laneResult, laneAnswered: answered, failures } = await attempt(e);
      laneAnswered = answered;
      try {
        if (!laneAnswered) {
          // The lane never spoke. The row carries every attempt's message, so a
          // single retry that also failed reads as TWO failures, not one.
          rec = errorRow(e, new Error(failures.join(' | retry: ')));
        } else {
          const raw = typeof laneResult?.raw === 'string' ? laneResult.raw : String(laneResult?.raw ?? '');
          finishReason = laneResult?.finishReason;
          outputBytes = Buffer.byteLength(raw, 'utf8');
          // Per-item log redirect BEFORE parsing: a record buildRecord rejects
          // still leaves the raw output on disk for diagnosis.
          if (itemLogPath) fs.writeFileSync(itemLogPath(e), raw);
          rec = buildRecord(e, laneResult);
          if (failures.length > 0) rec.retry = { attempts: 2, errors: failures };
        }
      } catch (err) {
        // buildRecord rejected a payload the lane DID produce — no retry, by the
        // header's rule: the lane answered, and a second identical call would
        // only relearn the same dialect death.
        rec = errorRow(e, err);
        if (failures.length > 0) rec.retry = { attempts: 2, errors: failures };
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
  stamp.retried = retried;
  stampSafe(stamp);
  return { stamp, records };
}
