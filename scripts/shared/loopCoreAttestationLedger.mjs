// sites-pinned: tests/shared/loop-core-attestation-ledger.test.ts
// The TRACKED loop-core attestation ledger: each loop-core path's committed
// CONTENT (its git blob id), bound to the review that vouched for it — or, for
// content unchanged since the ledger was introduced, to the BASELINE.
//
// WHY A TRACKED LEDGER. The review attestation the commit gate checks
// (`.claude/loop-core-review/<staged-tree>.json`) is local and gitignored, and
// the gate itself runs only from the per-clone `.githooks`. A cloud-agent commit
// made without those hooks, and a GitHub squash merge (which writes a commit no
// local hook ever sees), both landed loop-core content on `main` with nothing
// checking it (#14, 2026-09-30). A check that can run on the server must read
// evidence that travels WITH the tree, and evidence bound to a staged-tree id
// does not survive a squash or a rebase. A blob id does: it is the content's own
// address, identical on every machine and through every landing path. So the
// attest script records `path → blob → review` here, and
// `check:loop-core-attestations` verifies the WHOLE tree — every loop-core
// path's current blob is the one its entry vouches for, every entry cites an
// admissible record, and nothing in the ledger names a path or a record that is
// no longer in use. That invariant is range-free: it judges the tree that
// landed, whichever path it landed by, so CI (pull request and push to main),
// the release script's pre-tag gate and the publish workflow all run the same
// rule through verify:checks.
//
// SHAPE. One record per attestation (`reviews`), at most one `baselines` record,
// and one line-sized entry per path (`entries`: path → `{ review }` or
// `{ baseline }`), so two branches attesting different paths merge line-wise.
// Keys are sorted on every write.
//
// WHAT A RECORD VOUCHES FOR IS PART OF ITS ID. Every record carries `vouches`,
// the exact `path → blob` set it covers, and is filed under a hash of its whole
// record, `vouches` included; the check re-derives that hash. So new content
// cannot be slipped under an old record by editing a blob id in place: the
// edited record no longer hashes to its key, and the only way to make it verify
// is a record filed under a NEW key — a new, visible record in the diff. An
// entry's content is read from its record's `vouches`, never stored twice.
//
// THE BASELINE CLAIMS NO REVIEW. It records the loop-core content of one commit
// (the tree the ledger started from) and nothing else: no reviewer, no verdict.
// A baseline entry passes only while the file still holds exactly that content;
// any change needs a real review. It is written once, by
// `scripts/seed-loop-core-baseline.mjs` into a ledger with no entries; the
// attest script only ever writes reviews. The check reports how many files are
// still baseline-only, apart from the reviewed ones.
//
// THE HONEST LIMIT. Like the local record, this enforces existence, binding and
// verdict — not review quality. The ledger is hand-writable by anyone who can
// commit; what it guarantees is that unreviewed content cannot land SILENTLY: it
// either fails the check or carries an attributable, diffable record of who
// vouched for it.
//
// Pre-build plain-node module: the commit gate's leg, the attest hook and CI all
// import it before any build, so it imports the generated loop-core predicate,
// never the TypeScript source.
import { compareCodeUnits, hashContent } from './primitives.mjs';
import { isLoopCorePath } from '../../.claude/hooks/loop-core-patterns.mjs';

export const LEDGER_PATH = '.claude/loop-core-attestations.json';
const LEDGER_SCHEMA = 'loop-core-attestations/v1';

/**
 * @typedef {(args: string[]) => { ok: boolean, stdout: string, stderr?: string }} GitRunner
 * @typedef {object} Review
 * @property {string} reviewed_by
 * @property {'agent'|'human'} attester_class
 * @property {string} checked what was adversarially checked
 * @property {'clear'|'concerns'} verdict
 * @property {string|null} override
 * @property {string} attested_at ISO timestamp
 * @property {Record<string, string>} vouches path → blob: the exact content this review covers
 * @typedef {Omit<Review, 'vouches'>} ReviewMeta what the attester supplies; `vouches` is derived
 * @typedef {object} Baseline
 * @property {string} commit the full commit id whose loop-core content this records
 * @property {string} [notes] context only; never evidence of a review
 * @property {Record<string, string>} vouches path → blob: every loop-core path at `commit`
 * @typedef {{ review: string } | { baseline: string }} LedgerEntry
 * @typedef {{ schema_version: string, baselines: Record<string, Baseline>, reviews: Record<string, Review>, entries: Record<string, LedgerEntry> }} Ledger
 */

/**
 * Every tracked loop-core path and its blob id, read from the INDEX (`rev`
 * omitted — what the next commit carries) or from a tree-ish.
 * @param {GitRunner} git
 * @param {string} [rev]
 * @returns {Map<string, string> | null} null on a git fault
 */
export function loopCoreBlobs(git, rev) {
  const r = rev === undefined ? git(['ls-files', '-s', '-z']) : git(['ls-tree', '-r', '-z', rev]);
  if (!r.ok) return null;
  const out = new Map();
  for (const record of r.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    // ls-files -s: `<mode> <blob> <stage>`; ls-tree: `<mode> <type> <blob>`.
    const blob = rev === undefined ? meta[1] : meta[2];
    if (blob && isLoopCorePath(path)) out.set(path, blob);
  }
  return out;
}

/**
 * The ledger as committed in the index (`rev` omitted) or in a tree-ish.
 * @param {GitRunner} git
 * @param {string} [rev]
 * @returns {{ kind: 'missing' } | { kind: 'corrupt', reason: string } | { kind: 'ok', ledger: Ledger }}
 */
export function readLedger(git, rev) {
  const r = git(['show', `${rev ?? ''}:${LEDGER_PATH}`]);
  if (!r.ok) return { kind: 'missing' };
  return parseLedger(r.stdout);
}

/**
 * @param {string} text
 * @returns {{ kind: 'corrupt', reason: string } | { kind: 'ok', ledger: Ledger }}
 */
export function parseLedger(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { kind: 'corrupt', reason: `not JSON (${/** @type {Error} */ (err).message})` };
  }
  if (data?.schema_version !== LEDGER_SCHEMA) {
    return { kind: 'corrupt', reason: `schema_version is ${JSON.stringify(data?.schema_version)}, expected "${LEDGER_SCHEMA}"` };
  }
  for (const key of ['baselines', 'reviews', 'entries']) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) {
      return { kind: 'corrupt', reason: `\`${key}\` is not an object` };
    }
  }
  return { kind: 'ok', ledger: data };
}

/** @param {unknown} v */
function vouchesDefect(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0) {
    return 'has no `vouches` (the path → blob set it covers)';
  }
  if (Object.values(v).some((b) => typeof b !== 'string' || !b)) return 'has a `vouches` blob that is not a string';
  return null;
}

/**
 * Why a review is not an admissible record, or null. The same floor the attest
 * script enforces when it writes one, so a hand-written review cannot be thinner
 * than a scripted one.
 * @param {unknown} review
 * @returns {string | null}
 */
function reviewDefect(review) {
  const r = /** @type {Partial<Review>} */ (review ?? {});
  if (typeof r.reviewed_by !== 'string' || !r.reviewed_by.trim()) return 'has no `reviewed_by`';
  if (r.attester_class !== 'agent' && r.attester_class !== 'human') return '`attester_class` is not "agent" or "human"';
  if (typeof r.checked !== 'string' || r.checked.replace(/\s/g, '').length < 20) {
    return '`checked` is under 20 non-space characters';
  }
  if (r.verdict !== 'clear' && r.verdict !== 'concerns') return '`verdict` is not "clear" or "concerns"';
  return vouchesDefect(r.vouches);
}

/**
 * Why a baseline is not an admissible record, or null. Exactly `commit`,
 * `vouches` and an optional `notes`: a field that reads like a review (a
 * reviewer, a verdict) has no place in a record that claims none happened.
 * @param {unknown} baseline
 * @returns {string | null}
 */
function baselineDefect(baseline) {
  const b = /** @type {Partial<Baseline>} */ (baseline ?? {});
  if (typeof b.commit !== 'string' || !/^[0-9a-f]{40}$/.test(b.commit)) return '`commit` is not a full commit id';
  if (b.notes !== undefined && typeof b.notes !== 'string') return '`notes` is not a string';
  const extra = Object.keys(b).filter((k) => !['commit', 'notes', 'vouches'].includes(k));
  if (extra.length > 0) return `carries ${extra.map((k) => `\`${k}\``).join(', ')}, which a baseline may not (it claims no review)`;
  return vouchesDefect(b.vouches);
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort(compareCodeUnits);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(/** @type {any} */ (value)[k])}`).join(',')}}`;
}

/**
 * The id a record is filed under: a hash of its whole record, `vouches`
 * included, so the key commits to exactly the content the record covers. The
 * check re-derives it; an in-place edit of any field breaks the match.
 * @param {Review | Baseline} record
 */
function recordId(record) {
  return hashContent(canonicalJson(record), { length: 16 });
}

/**
 * The two record kinds, so every walk over them is one loop.
 * @param {Ledger} ledger
 */
function kinds(ledger) {
  return /** @type {const} */ ([
    { kind: 'review', records: ledger.reviews, defect: reviewDefect },
    { kind: 'baseline', records: ledger.baselines, defect: baselineDefect },
  ]);
}

/**
 * The record an entry cites, or why it cites none that is admissible.
 * @param {Ledger} ledger
 * @param {LedgerEntry | undefined} entry
 * @returns {{ kind: 'review'|'baseline', id: string, record: any } | { error: string }}
 */
function citedRecord(ledger, entry) {
  if (!entry || typeof entry !== 'object') return { error: 'no attestation entry' };
  const keys = Object.keys(entry);
  if (keys.length !== 1 || (keys[0] !== 'review' && keys[0] !== 'baseline')) {
    return { error: 'the entry must cite exactly one `review` or one `baseline`' };
  }
  const k = /** @type {'review'|'baseline'} */ (keys[0]);
  const id = /** @type {any} */ (entry)[k];
  const { records, defect } = kinds(ledger).find((x) => x.kind === k) ?? kinds(ledger)[0];
  const record = Object.hasOwn(records, id) ? records[id] : undefined;
  if (!record) return { error: `the entry cites ${k} ${JSON.stringify(id)}, which the ledger does not hold` };
  if (defect(record) || recordId(record) !== id) return { error: `the entry cites ${k} ${id}, which is not admissible (see above)` };
  return { kind: k, id, record };
}

/**
 * Judge a tree against its own ledger. Range-free on purpose: the property is
 * about the tree that landed, not the commits that built it.
 * @param {object} opts
 * @param {GitRunner} opts.git
 * @param {string} [opts.rev] tree-ish; omitted = the index
 * @param {boolean} opts.concernsBlock whether a `concerns` verdict without an
 *   override refuses (true when the tree can land on `main` — the same
 *   destination key the commit gate applies to the local record)
 * @returns {{ fault: string | null, problems: string[], reviewed: number, baselineOnly: number }}
 *   `fault` = git could not answer (no verdict); `problems` empty = the ledger
 *   vouches for the tree; the counts split the paths that passed by kind
 */
export function verifyLedger({ git, rev, concernsBlock }) {
  const counts = { reviewed: 0, baselineOnly: 0 };
  const blobs = loopCoreBlobs(git, rev);
  if (blobs === null) return { fault: 'git could not list the tree', problems: [], ...counts };
  const loaded = readLedger(git, rev);
  if (loaded.kind === 'missing') {
    return {
      fault: null,
      problems: blobs.size === 0 ? [] : [`${LEDGER_PATH} is missing, so none of ${blobs.size} loop-core path(s) is attested`],
      ...counts,
    };
  }
  if (loaded.kind === 'corrupt') return { fault: null, problems: [`${LEDGER_PATH} is unreadable: ${loaded.reason}`], ...counts };
  const ledger = loaded.ledger;
  const problems = [];
  for (const { kind, records, defect } of kinds(ledger)) {
    for (const [id, record] of Object.entries(records).sort(([a], [b]) => compareCodeUnits(a, b))) {
      const d = defect(record);
      if (d) problems.push(`${kind} ${id} ${d}`);
      else if (recordId(record) !== id) {
        problems.push(
          `${kind} ${id} does not hash to its own key (its record says ${recordId(record)}): it was edited after ` +
            `it was filed, so it vouches for nothing — new content needs a new review (re-attest)`,
        );
      }
    }
  }
  if (Object.keys(ledger.baselines).length > 1) problems.push('the ledger holds more than one baseline');
  /** @type {Set<string>} `<kind>:<id>` of every cited record */
  const cited = new Set();
  for (const path of [...blobs.keys()].sort(compareCodeUnits)) {
    const entry = ledger.entries[path];
    if (entry && typeof entry === 'object') {
      for (const [k, id] of Object.entries(entry)) cited.add(`${k}:${id}`);
    }
    const found = citedRecord(ledger, entry);
    if ('error' in found) {
      problems.push(`${path}: ${found.error}`);
      continue;
    }
    const vouched = found.record.vouches[path];
    const tree = blobs.get(path);
    if (vouched !== tree) {
      problems.push(
        found.kind === 'baseline'
          ? `${path}: content changed since the baseline (commit ${found.record.commit.slice(0, 12)}) — a change ` +
              `needs a real review (attest it)`
          : `${path}: content is not the attested content (review ${found.id} vouches for ` +
              `${vouched ? `blob ${String(vouched).slice(0, 12)}` : 'nothing at this path'}, ` +
              `tree has ${String(tree).slice(0, 12)})`,
      );
      continue;
    }
    if (found.kind === 'baseline') {
      counts.baselineOnly++;
      continue;
    }
    counts.reviewed++;
    if (found.record.verdict === 'concerns' && !found.record.override && concernsBlock) {
      problems.push(`${path}: attested with verdict "concerns" and no override, which cannot land on main`);
    }
  }
  for (const path of Object.keys(ledger.entries).sort(compareCodeUnits)) {
    if (!blobs.has(path)) problems.push(`${path}: the entry names a path that is not a tracked loop-core file (re-attest to drop it)`);
  }
  for (const { kind, records } of kinds(ledger)) {
    for (const id of Object.keys(records).sort(compareCodeUnits)) {
      if (!cited.has(`${kind}:${id}`)) problems.push(`${kind} ${id} is cited by no entry (re-attest to drop it)`);
    }
  }
  return { fault: null, problems, ...counts };
}

/**
 * Keep only the entries for tracked loop-core paths and the records they cite.
 * @param {Record<string, Baseline>} baselinesIn
 * @param {Record<string, Review>} reviewsIn
 * @param {Record<string, LedgerEntry>} entriesIn
 * @param {Map<string, string>} blobs
 * @returns {Ledger}
 */
function pruned(baselinesIn, reviewsIn, entriesIn, blobs) {
  /** @type {Record<string, LedgerEntry>} */
  const entries = {};
  for (const path of Object.keys(entriesIn).sort(compareCodeUnits)) {
    if (blobs.has(path)) entries[path] = entriesIn[path];
  }
  const cited = new Set(Object.values(entries).flatMap((e) => Object.entries(e).map(([k, id]) => `${k}:${id}`)));
  /** @param {string} kind @param {Record<string, any>} all */
  const keep = (kind, all) =>
    Object.fromEntries(Object.keys(all).sort(compareCodeUnits).filter((id) => cited.has(`${kind}:${id}`)).map((id) => [id, all[id]]));
  return { schema_version: LEDGER_SCHEMA, baselines: keep('baseline', baselinesIn), reviews: keep('review', reviewsIn), entries };
}

/**
 * The ledger after an attestation: the review records the current blob of
 * every path in `attest` as its `vouches` and is filed under the hash of that
 * whole record; each such path's entry cites it. Entries whose path is no longer
 * a tracked loop-core file, and records no entry cites, are dropped. Keys are
 * sorted. Only ever writes a REVIEW: a baseline comes from `seedBaseline` alone.
 * @param {Ledger | null} ledger
 * @param {Map<string, string>} blobs current loop-core blobs (see loopCoreBlobs)
 * @param {Iterable<string>} attest paths this attestation vouches for
 * @param {ReviewMeta} meta
 * @returns {Ledger}
 */
export function applyAttestation(ledger, blobs, attest, meta) {
  /** @type {Record<string, string>} */
  const vouches = {};
  for (const path of [...attest].sort(compareCodeUnits)) {
    const blob = blobs.get(path);
    if (blob) vouches[path] = blob;
  }
  const used = Object.keys(vouches).length > 0;
  /** @type {Review} */
  const review = { ...meta, vouches };
  const id = recordId(review);
  /** @type {Record<string, LedgerEntry>} */
  const merged = { ...(ledger?.entries ?? {}) };
  for (const path of Object.keys(vouches)) merged[path] = { review: id };
  const allReviews = { ...(ledger?.reviews ?? {}), ...(used ? { [id]: review } : {}) };
  return pruned(ledger?.baselines ?? {}, allReviews, merged, blobs);
}

/**
 * The ledger's one baseline: every loop-core path of `commit` at its blob there,
 * with an entry for each such path still tracked. Refuses (returns `error`) when
 * the ledger already holds a baseline or any entry — a baseline is the starting
 * point, never a way to overwrite what a review recorded.
 * @param {Ledger | null} ledger
 * @param {object} opts
 * @param {string} opts.commit full commit id
 * @param {Map<string, string>} opts.commitBlobs loop-core blobs of `commit`
 * @param {Map<string, string>} opts.blobs loop-core blobs of the index
 * @param {string} [opts.notes]
 * @returns {{ ledger: Ledger } | { error: string }}
 */
export function seedBaseline(ledger, { commit, commitBlobs, blobs, notes }) {
  if (ledger && Object.keys(ledger.baselines ?? {}).length > 0) return { error: 'the ledger already has a baseline' };
  if (ledger && Object.keys(ledger.entries ?? {}).length > 0) {
    return { error: 'the ledger already has entries; a baseline is written only into an empty ledger' };
  }
  if (commitBlobs.size === 0) return { error: `commit ${commit} has no loop-core path` };
  /** @type {Baseline} */
  const baseline = {
    commit,
    ...(notes ? { notes } : {}),
    vouches: Object.fromEntries([...commitBlobs.entries()].sort(([a], [b]) => compareCodeUnits(a, b))),
  };
  const id = recordId(baseline);
  /** @type {Record<string, LedgerEntry>} */
  const entries = {};
  for (const path of commitBlobs.keys()) entries[path] = { baseline: id };
  return { ledger: pruned({ [id]: baseline }, {}, entries, blobs) };
}

/**
 * Loop-core paths the ledger does not already vouch for at their current blob:
 * no entry, an entry citing a missing or tampered record, or a record that
 * vouches for other content (a changed baseline file included).
 * @param {Ledger | null} ledger
 * @param {Map<string, string>} blobs
 * @returns {string[]}
 */
export function unvouchedPaths(ledger, blobs) {
  if (!ledger) return [...blobs.keys()].sort(compareCodeUnits);
  return [...blobs.keys()]
    .filter((p) => {
      const found = citedRecord(ledger, ledger.entries[p]);
      return 'error' in found || found.record.vouches[p] !== blobs.get(p);
    })
    .sort(compareCodeUnits);
}

/** @param {Ledger} ledger */
export function serializeLedger(ledger) {
  return JSON.stringify(ledger, null, 2) + '\n';
}

/**
 * Whether the tree being judged can land on `main`. Pull request: its base.
 * Push or tag: its ref. Otherwise the checked-out branch; a detached or
 * unreadable HEAD is treated as main (fail-closed).
 * @param {GitRunner} git
 * @param {NodeJS.ProcessEnv} env
 */
export function targetsMain(git, env) {
  if (env.GITHUB_BASE_REF) return env.GITHUB_BASE_REF === 'main';
  if (env.GITHUB_REF) return env.GITHUB_REF === 'refs/heads/main' || env.GITHUB_REF.startsWith('refs/tags/');
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = br.ok ? br.stdout.trim() : '';
  return branch === '' || branch === 'HEAD' || branch === 'main';
}
