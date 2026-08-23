// Session registry + the `-z` porcelain identity the session-scoped gates
// share. Consumers: session-start-guards (registration + baseline capture),
// closeout-challenge-gate (partition read + child skip), and the friction-stop /
// question-philosophy / pre-commit gates (registry read).
//
// Every function is fail-soft: fs/git faults return the empty/neutral value,
// never throw — a registry fault must degrade a gate to its old behavior, not
// wedge a session.
//
// The plain-porcelain classifier in scripts/release-and-publish.mjs
// (assessWorktreeCleanliness) is deliberately NOT here: it parses a different
// dialect (plain rows, kept verbatim for operator-facing refusal/warn lists),
// not this identity parse.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSIONS_DIR_SEGMENTS = ['.claude', 'hooks', '.state', 'sessions'];

export function sessionsDir(root) {
  return join(root, ...SESSIONS_DIR_SEGMENTS);
}

// The same `[^\w.-]` strip the session-keyed gates use — the id doubles as a
// file name, so anything path-shaped is removed.
export function sanitizeSessionId(raw) {
  return String(raw ?? '').replace(/[^\w.-]/g, '');
}

// Canonical porcelain argv — BOTH the baseline capture and every partition read
// must run exactly this, or partition identity silently breaks:
// `--untracked-files=all` stops an untracked DIRECTORY from collapsing into one
// `?? dir/` row (a baseline `dir/` would otherwise swallow session-created
// files beneath it — silently missing own-session work, the one ruled-out
// failure); `--ignore-submodules=all` keeps entry sets stable and matches the
// release script's read.
export const PORCELAIN_STATUS_ARGS = [
  'status',
  '--porcelain',
  '-z',
  '--untracked-files=all',
  '--ignore-submodules=all',
];

// Parse `git status --porcelain -z` stdout into entries. NUL-separated records;
// each record is `XY<space><path>`; when XY names a rename/copy ('R'/'C' in
// either column, defensively), the NEXT NUL token is the rename/copy ORIGIN
// path and is consumed into the same entry.
//
// Paths are git-emitted: forward-slash, repo-root-relative, unquoted (`-z`
// emits raw bytes — no C-style quoting, so no unquoting logic and no
// core.quotepath sensitivity). No further normalization is applied: identity is
// exact-string equality of these root-relative paths. A path containing \r or
// \n is carried verbatim (records are NUL-separated). The trailing empty token
// from the final NUL is dropped.
//
// One scan, two mappings. `scanPorcelainZ` — the core — returns null when any
// record fails the shape check, so a caller can tell MALFORMED from EMPTY
// (empty stdout is a well-formed zero-record stream, i.e. a clean tree).
// `parsePorcelainZ` is the standalone fail-soft view: malformed input → [],
// the neutral value, never a throw.
function scanPorcelainZ(stdout) {
  if (typeof stdout !== 'string') return null;
  if (stdout.length === 0) return [];
  const tokens = stdout.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 4 || token[2] !== ' ') return null;
    const xy = token.slice(0, 2);
    const paths = [token.slice(3)];
    if (/[RC]/.test(xy)) {
      i += 1;
      const origin = tokens[i];
      if (origin === undefined || origin.length === 0) return null;
      paths.push(origin);
    }
    entries.push({
      xy,
      paths,
      display: paths.length > 1 ? `${xy} ${paths[0]} <- ${paths[1]}` : `${xy} ${paths[0]}`,
    });
  }
  return entries;
}

export function parsePorcelainZ(stdout) {
  const entries = scanPorcelainZ(stdout);
  return entries ?? [];
}

// The baseline value stored in a record: every path named by any entry (both
// sides of a rename — either name pre-existing the session is pre-session
// dirt), deduplicated, LEXICOGRAPHICALLY SORTED (repo invariant: stable
// content-derived array order).
export function baselineFromEntries(entries) {
  const paths = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const path of entry?.paths ?? []) paths.add(path);
  }
  return [...paths].sort();
}

// The one porcelain read every consumer shares. stdout is used RAW, never
// trimmed: String.trim() would eat the leading space of a first-sorted
// ` M path` record — an unstaged tracked modification, the modal closeout
// dirt — and slice a phantom path out of the very identity the partition
// compares.
//
// `ok` means "this read is trustworthy": git exited zero AND the stream
// parsed. A malformed stream from a SUCCESSFUL git run is a GATE FAULT
// (ok:false), not a clean tree — collapsing it into ok:true + [] reads
// unparseable status as zero dirt and silences every session gate, the exact
// fail-open this module bans. Consumers report clean ONLY on ok AND empty
// entries; a fault degrades each gate to its pre-partition whole-tree behavior
// (over-fire), never silence.
export function runPorcelainStatus(root) {
  try {
    const r = spawnSync('git', PORCELAIN_STATUS_ARGS, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return { ok: false, entries: [] };
    const entries = scanPorcelainZ(r.stdout ?? '');
    if (entries === null) return { ok: false, entries: [] };
    return { ok: true, entries };
  } catch {
    return { ok: false, entries: [] };
  }
}

// Write `<sessionsDir>/<sessionId>.json` ATOMICALLY (same-directory temp +
// rename, so a concurrent reader never sees a torn record). FIRST-WRITE-WINS:
// a SessionStart re-fire on resume/clear with the same session_id must NOT
// refresh the baseline — refreshing would reclassify the session's own
// pre-resume dirt as foreign and silence the gate on real work. The skip path
// DOES refresh the record's mtime so a resumed session stays ahead of the
// prune horizon. Returns true if written, false if skipped/failed.
export function writeSessionRecord(root, record) {
  try {
    const sid = sanitizeSessionId(record?.session_id);
    if (!sid) return false;
    const dir = sessionsDir(root);
    const finalPath = join(dir, `${sid}.json`);
    if (existsSync(finalPath)) {
      try {
        const now = new Date();
        utimesSync(finalPath, now, now);
      } catch {
        /* refresh is best-effort */
      }
      return false;
    }
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `${sid}.json.${process.pid}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(record, null, 2));
    renameSync(tmpPath, finalPath);
    return true;
  } catch {
    return false;
  }
}

// Read + classify: { state: 'absent' | 'ok' | 'corrupt', record: object|null }.
//   absent  — file does not exist
//   ok      — parsed, record.session_id matches, baseline is an array
//   corrupt — exists but unreadable/unparseable/wrong-shape
// The three-way split is load-bearing: gates treat 'absent' as UNREGISTERED
// (child) but 'corrupt' as REGISTERED with an empty baseline — a corrupt
// record must degrade to today's whole-tree over-firing ("no worse than
// today"), never to gate silence for the owner.
export function readSessionRecord(root, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return { state: 'absent', record: null };
  const recordPath = join(sessionsDir(root), `${sid}.json`);
  if (!existsSync(recordPath)) return { state: 'absent', record: null };
  try {
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.session_id === sid &&
      Array.isArray(parsed.baseline)
    ) {
      return { state: 'ok', record: parsed };
    }
    return { state: 'corrupt', record: null };
  } catch {
    return { state: 'corrupt', record: null };
  }
}

// Enforcement-armed predicate: the sessions dir exists AND contains ≥1 `*.json`
// record. Protects the transitional window — until the first post-feature
// session starts, no gate changes behavior anywhere. readdir fault → false
// (not armed → old behavior).
export function enforcementArmed(root) {
  try {
    return readdirSync(sessionsDir(root)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

// One-call read for every Stop/PreToolUse gate. An EMPTY sessionId is never
// classified as a child: real children always carry session_id (probed
// 2026-08-18), so an empty one means an older payload shape — gates keep their
// current empty-sid behavior (closeout/question: fail open for cap reasons;
// friction: proceed).
export function readSessionRegistry(root, rawSessionId) {
  const sessionId = sanitizeSessionId(rawSessionId);
  const armed = enforcementArmed(root);
  const { state: recordState, record } = readSessionRecord(root, sessionId);
  return {
    armed,
    sessionId,
    recordState,
    record,
    isUnregisteredChild: armed && sessionId !== '' && recordState === 'absent',
  };
}

// Best-effort hygiene: unlink `*.json` records older than maxAgeMs by mtime.
// 30 days, not shorter: writeSessionRecord's first-write-wins skip refreshes
// mtime on every resume re-fire, so only a session untouched for the whole
// horizon loses its record (accepted residual — its Stop gates then go silent
// until it restarts). Every stat/unlink individually try/caught (concurrent
// prune races → ENOENT → ignore).
export function pruneStaleSessionRecords(root, maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
  let names = [];
  try {
    names = readdirSync(sessionsDir(root));
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    // Records, plus `.json.<pid>.tmp` residue a process death between write and
    // rename can strand — nothing else ever reaps those.
    if (!name.endsWith('.json') && !(name.includes('.json.') && name.endsWith('.tmp'))) continue;
    const recordPath = join(sessionsDir(root), name);
    try {
      if (statSync(recordPath).mtimeMs < cutoff) unlinkSync(recordPath);
    } catch {
      /* concurrent prune / vanished file — ignore */
    }
  }
}

// ── CLI: explicit-id self-registration ───────────────────────────────────────
//   node scripts/shared/sessionRegistry.mjs --register <session-id>
// Explicit id ONLY — deliberately NO discovery mode: a newest-transcript guess
// can register a CONCURRENT session's id, arming enforcement while leaving the
// invoker refused. The id comes from a hook payload the operator already holds.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    // A real flag, exit 0: `--help` is also the module's declared smoke command
    // (it proves the module loads and executes), so it must not share the
    // missing-argument usage path's non-zero exit.
    console.log('usage: node scripts/shared/sessionRegistry.mjs --register <session-id>');
    process.exit(0);
  }
  const flagIndex = args.indexOf('--register');
  const rawId = flagIndex === -1 ? undefined : args[flagIndex + 1];
  if (rawId === undefined) {
    console.error('usage: node scripts/shared/sessionRegistry.mjs --register <session-id>');
    process.exit(1);
  }
  const sid = sanitizeSessionId(rawId);
  if (!sid) {
    console.error(
      `refusing to register: session id ${JSON.stringify(rawId)} sanitizes to an empty string.`,
    );
    process.exit(1);
  }
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const wrote = writeSessionRecord(root, {
    version: 1,
    session_id: sid,
    registered_at: new Date().toISOString(),
    source: 'self-registration',
    baseline: [],
  });
  if (!wrote && !existsSync(join(sessionsDir(root), `${sid}.json`))) {
    console.error(`failed to write the session record for ${sid}.`);
    process.exit(1);
  }
  console.log(
    wrote
      ? `registered session ${sid} (baseline: empty — whole-tree behavior for this session).`
      : `session ${sid} was already registered — record left unchanged (first-write-wins).`,
  );
}
