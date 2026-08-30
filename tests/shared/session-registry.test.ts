// Contract tests for `scripts/shared/sessionRegistry.mjs` — the session
// registry substrate serving the child-session split and the closeout tree-dirt
// partition (Builds 1+3). The unit half pins the `-z` porcelain identity and
// the registry contracts (`readSessionRegistry` is the ONE predicate the
// Stop/PreToolUse gates import); the spawn half pins the SessionStart
// registration leg end-to-end and the explicit-id CLI.
//
// Same placement rule as the other hook tests: under tests/ because vitest
// excludes `.claude/**`, so a test beside a hook never runs in CI.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import {
  PORCELAIN_STATUS_ARGS,
  baselineFromEntries,
  enforcementArmed,
  parsePorcelainZ,
  pruneStaleSessionRecords,
  readSessionRecord,
  readSessionRegistry,
  runPorcelainStatus,
  sanitizeSessionId,
  sessionsDir,
  writeSessionRecord,
} from '../../scripts/shared/sessionRegistry.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GUARDS = join(REPO_ROOT, '.claude', 'hooks', 'session-start-guards.mjs');
const LIB = join(REPO_ROOT, 'scripts', 'shared', 'sessionRegistry.mjs');

const DAY_MS = 24 * 60 * 60 * 1000;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp reaper */
    }
  }
});

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sessreg-'));
  roots.push(root);
  return root;
}

function gitRepo(): string {
  const root = scratchRoot();
  const g = (...args: string[]) =>
    spawnSyncHidden('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.ts'), 'export const one = 1;\n');
  g('add', '.');
  g('commit', '-qm', 'initial');
  return root;
}

const record = (sessionId: string, baseline: string[] = []) => ({
  version: 1,
  session_id: sessionId,
  registered_at: new Date().toISOString(),
  source: 'test',
  baseline,
});

describe('parsePorcelainZ: the -z porcelain identity', () => {
  it('parses simple records, preserving the leading space of a first-sorted ` M` record', () => {
    expect(parsePorcelainZ('?? a.txt\0 M b/c.ts\0')).toEqual([
      { xy: '??', paths: ['a.txt'], display: '?? a.txt' },
      { xy: ' M', paths: ['b/c.ts'], display: ' M b/c.ts' },
    ]);
    // The trim trap: an unstaged tracked modification is ` M path`, and git
    // sorts records by path, so it is routinely the FIRST record — a trimmed
    // read eats its leading space and slices a phantom path.
    expect(parsePorcelainZ(' M a.ts\0?? b.txt\0')).toEqual([
      { xy: ' M', paths: ['a.ts'], display: ' M a.ts' },
      { xy: '??', paths: ['b.txt'], display: '?? b.txt' },
    ]);
  });

  it('consumes the rename ORIGIN token into the entry instead of swallowing the next record', () => {
    expect(parsePorcelainZ('R  new.txt\0old.txt\0?? c.txt\0')).toEqual([
      { xy: 'R ', paths: ['new.txt', 'old.txt'], display: 'R  new.txt <- old.txt' },
      { xy: '??', paths: ['c.txt'], display: '?? c.txt' },
    ]);
  });

  it('keeps a path with spaces whole — -z emits raw bytes, no quoting to undo', () => {
    expect(parsePorcelainZ('?? a b.txt\0')).toEqual([{ xy: '??', paths: ['a b.txt'], display: '?? a b.txt' }]);
  });

  it('degrades empty and malformed input to []', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ('garbage with no record shape')).toEqual([]);
    expect(parsePorcelainZ(undefined as unknown as string)).toEqual([]);
  });
});

describe('baselineFromEntries', () => {
  it('includes both rename sides, deduped and lexicographically sorted', () => {
    const entries = parsePorcelainZ('R  b-new.txt\0a-old.txt\0?? c.txt\0?? a-old.txt\0');
    expect(baselineFromEntries(entries)).toEqual(['a-old.txt', 'b-new.txt', 'c.txt']);
  });
});

describe('sanitizeSessionId', () => {
  it('strips everything path-shaped, keeping word chars, dots and dashes', () => {
    expect(sanitizeSessionId('7430f400-abc.DEF_1')).toBe('7430f400-abc.DEF_1');
    expect(sanitizeSessionId('../../evil')).toBe('....evil');
    expect(sanitizeSessionId(undefined)).toBe('');
    expect(sanitizeSessionId('///')).toBe('');
  });
});

describe('enforcementArmed', () => {
  it('is false with no sessions dir, false with an empty dir, true with one record', () => {
    const root = scratchRoot();
    expect(enforcementArmed(root)).toBe(false);
    mkdirSync(sessionsDir(root), { recursive: true });
    expect(enforcementArmed(root)).toBe(false);
    writeSessionRecord(root, record('arming-sid'));
    expect(enforcementArmed(root)).toBe(true);
  });
});

describe('readSessionRecord: the three-way absent/ok/corrupt split', () => {
  it('classifies a missing record as absent', () => {
    expect(readSessionRecord(scratchRoot(), 'nobody')).toEqual({ state: 'absent', record: null });
  });

  it('returns ok with the parsed record for a valid write', () => {
    const root = scratchRoot();
    writeSessionRecord(root, record('valid-sid', ['a.txt']));
    const r = readSessionRecord(root, 'valid-sid');
    expect(r.state).toBe('ok');
    expect(r.record?.baseline).toEqual(['a.txt']);
  });

  it('classifies unparseable JSON and a non-array baseline as corrupt — never absent', () => {
    // Load-bearing: gates treat `absent` as UNREGISTERED (child skip) but
    // `corrupt` as REGISTERED with an empty baseline — degrading to whole-tree
    // over-firing, never to gate silence for the owner.
    const root = scratchRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), 'garbled.json'), 'not json{{{');
    expect(readSessionRecord(root, 'garbled').state).toBe('corrupt');
    writeFileSync(
      join(sessionsDir(root), 'shapeless.json'),
      JSON.stringify({ version: 1, session_id: 'shapeless', baseline: 'nope' }),
    );
    expect(readSessionRecord(root, 'shapeless').state).toBe('corrupt');
  });
});

describe('readSessionRegistry: the one predicate every gate imports (Build 1 contract)', () => {
  it('classifies a child ONLY as armed + non-empty sid + absent record', () => {
    const armedRoot = scratchRoot();
    writeSessionRecord(armedRoot, record('resident'));
    expect(readSessionRegistry(armedRoot, 'stranger').isUnregisteredChild).toBe(true);

    // Not armed → never a child (the transitional-window guarantee).
    expect(readSessionRegistry(scratchRoot(), 'stranger').isUnregisteredChild).toBe(false);

    // Empty (or unsanitizable) sid → an older payload shape, never a child.
    expect(readSessionRegistry(armedRoot, '').isUnregisteredChild).toBe(false);
    expect(readSessionRegistry(armedRoot, undefined).isUnregisteredChild).toBe(false);

    // Corrupt-but-present → REGISTERED with an empty baseline, never a child.
    const corruptRoot = scratchRoot();
    mkdirSync(sessionsDir(corruptRoot), { recursive: true });
    writeFileSync(join(sessionsDir(corruptRoot), 'broken.json'), '{{{');
    const reg = readSessionRegistry(corruptRoot, 'broken');
    expect(reg.recordState).toBe('corrupt');
    expect(reg.isUnregisteredChild).toBe(false);

    // The registered resident itself.
    const resident = readSessionRegistry(armedRoot, 'resident');
    expect(resident.recordState).toBe('ok');
    expect(resident.isUnregisteredChild).toBe(false);
  });
});

describe('writeSessionRecord: atomic, first-write-wins', () => {
  it('never refreshes the baseline for an existing record, and leaves no tmp residue', () => {
    const root = scratchRoot();
    expect(writeSessionRecord(root, record('fww', ['first.txt']))).toBe(true);
    expect(writeSessionRecord(root, record('fww', ['second.txt']))).toBe(false);
    expect(readSessionRecord(root, 'fww').record?.baseline).toEqual(['first.txt']);
    expect(readdirSync(sessionsDir(root)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('refreshes the record mtime on the skip path so a resumed session outlives the prune horizon', () => {
    const root = scratchRoot();
    writeSessionRecord(root, record('resumed', ['keep.txt']));
    const path = join(sessionsDir(root), 'resumed.json');
    const old = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(path, old, old);
    writeSessionRecord(root, record('resumed', ['ignored.txt'])); // resume re-fire
    expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - 60 * 60 * 1000);
    pruneStaleSessionRecords(root);
    expect(existsSync(path)).toBe(true);
    expect(readSessionRecord(root, 'resumed').record?.baseline).toEqual(['keep.txt']);
  });

  it('refuses a record whose session id sanitizes to nothing', () => {
    const root = scratchRoot();
    expect(writeSessionRecord(root, record('///'))).toBe(false);
    expect(existsSync(sessionsDir(root))).toBe(false);
  });
});

describe('pruneStaleSessionRecords: 30-day mtime horizon', () => {
  it('removes a 31-day-old record and keeps a 29-day-old one', () => {
    const root = scratchRoot();
    writeSessionRecord(root, record('ancient'));
    writeSessionRecord(root, record('recent-enough'));
    const stale = join(sessionsDir(root), 'ancient.json');
    const when31 = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(stale, when31, when31);
    const young = join(sessionsDir(root), 'recent-enough.json');
    const when29 = new Date(Date.now() - 29 * DAY_MS);
    utimesSync(young, when29, when29);
    pruneStaleSessionRecords(root);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it('reaps stranded .json.<pid>.tmp residue past the horizon, and only past it', () => {
    const root = scratchRoot();
    writeSessionRecord(root, record('anchor')); // ensures the dir exists
    const staleTmp = join(sessionsDir(root), 'dead.json.12345.tmp');
    const youngTmp = join(sessionsDir(root), 'live.json.6789.tmp');
    writeFileSync(staleTmp, '{}');
    writeFileSync(youngTmp, '{}');
    const when31 = new Date(Date.now() - 31 * DAY_MS);
    utimesSync(staleTmp, when31, when31);
    pruneStaleSessionRecords(root);
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(youngTmp)).toBe(true);
  });
});

describe('runPorcelainStatus: raw, untrimmed, canonical argv', () => {
  it('preserves a first-sorted tracked modification exactly', () => {
    const root = gitRepo();
    writeFileSync(join(root, 'a.ts'), 'export const one = 2;\n'); // ` M a.ts`, sorts first
    writeFileSync(join(root, 'z.txt'), 'untracked\n');
    const r = runPorcelainStatus(root);
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([
      { xy: ' M', paths: ['a.ts'], display: ' M a.ts' },
      { xy: '??', paths: ['z.txt'], display: '?? z.txt' },
    ]);
  });

  it('fails soft outside a git repo', () => {
    expect(runPorcelainStatus(scratchRoot())).toEqual({ ok: false, entries: [] });
  });

  it('pins the one canonical argv both the capture and every partition read must share', () => {
    expect(PORCELAIN_STATUS_ARGS).toEqual([
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ]);
  });
});

// ── SessionStart registration leg, end-to-end ────────────────────────────────

function runGuards(
  root: string,
  payload?: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): { code: number | null; stdout: string } {
  // Scrub the child marker: running this suite FROM a dispatched child session
  // must not flip the registration cases. Re-added only by the case testing it.
  const inherited = { ...process.env };
  delete inherited.AUDIT_TOOLS_CHILD_SESSION;
  const r = spawnSyncHidden(process.execPath, [GUARDS], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...inherited,
      CLAUDE_PROJECT_DIR: root,
      // Hermetic lane probes: EVERY http lane is pointed at an unroutable
      // loopback port (refused instantly — no live service is probed and no 2s
      // timeout is burned per spawn), and the command-probe lane is skipped.
      AUDIT_TOOLS_OFFLOAD_PROBE_URL: 'http://127.0.0.1:9/',
      AUDIT_TOOLS_HEADROOM_PROBE_URL: 'http://127.0.0.1:9/',
      AUDIT_TOOLS_AGY_PROBE_CMD: 'skip',
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '' };
}

const startPayload = (sessionId?: string): Record<string, unknown> => ({
  hook_event_name: 'SessionStart',
  ...(sessionId === undefined ? {} : { session_id: sessionId }),
  source: 'startup',
});

describe('session-start-guards: the registration leg (end-to-end)', () => {
  it('registers the session with the tree-dirt baseline, including a first-sorted tracked modification', () => {
    const root = gitRepo();
    writeFileSync(join(root, 'a.ts'), 'export const one = 2;\n'); // ` M a.ts` — the trim trap
    writeFileSync(join(root, 'pre.txt'), 'pre-session\n');
    const sid = `reg-${process.pid}`;
    const pass = runGuards(root, startPayload(sid));
    expect(pass.code).toBe(0);
    const recordPath = join(sessionsDir(root), `${sid}.json`);
    expect(existsSync(recordPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.session_id).toBe(sid);
    expect(parsed.source).toBe('startup');
    expect(parsed.baseline).toEqual(['a.ts', 'pre.txt']);
  });

  it('refuses to register a dispatched child (AUDIT_TOOLS_CHILD_SESSION=1) and says so', () => {
    const root = gitRepo();
    const sid = `child-${process.pid}`;
    const pass = runGuards(root, startPayload(sid), { AUDIT_TOOLS_CHILD_SESSION: '1' });
    expect(pass.code).toBe(0);
    expect(pass.stdout).toMatch(/NOT registered/);
    expect(existsSync(join(sessionsDir(root), `${sid}.json`))).toBe(false);
  });

  it('skips registration without a session_id, noting the fallback', () => {
    const root = gitRepo();
    const pass = runGuards(root, startPayload());
    expect(pass.code).toBe(0);
    expect(pass.stdout).toMatch(/no session_id/);
    expect(existsSync(sessionsDir(root))).toBe(false);
  });

  it('sanitizes a path-shaped session_id INTO the sessions dir', () => {
    const root = gitRepo();
    const pass = runGuards(root, startPayload('../../evil'));
    expect(pass.code).toBe(0);
    // Nothing lands where the traversal pointed…
    expect(existsSync(join(root, '.claude', 'hooks', 'evil.json'))).toBe(false);
    expect(existsSync(join(root, '.claude', 'evil.json'))).toBe(false);
    // …and exactly one record lands inside, with no path separator in its name.
    const names = readdirSync(sessionsDir(root)).filter((n) => n.endsWith('.json'));
    expect(names).toEqual(['....evil.json']);
  });

  it('keeps the ORIGINAL baseline on a resume re-fire (first-write-wins end-to-end)', () => {
    const root = gitRepo();
    writeFileSync(join(root, 'pre.txt'), 'pre-session\n');
    const sid = `resume-${process.pid}`;
    expect(runGuards(root, startPayload(sid)).code).toBe(0);
    writeFileSync(join(root, 'mid.txt'), 'work between the two fires\n');
    expect(runGuards(root, startPayload(sid)).code).toBe(0);
    const parsed = JSON.parse(readFileSync(join(sessionsDir(root), `${sid}.json`), 'utf8'));
    expect(parsed.baseline).toEqual(['pre.txt']);
  });
});

// ── CLI: explicit-id self-registration only ──────────────────────────────────

describe('sessionRegistry CLI: --register <session-id>, no discovery mode', () => {
  function runCli(root: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
    const inherited = { ...process.env };
    delete inherited.AUDIT_TOOLS_CHILD_SESSION;
    const r = spawnSyncHidden(process.execPath, [LIB, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...inherited, CLAUDE_PROJECT_DIR: root },
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('registers an explicit id with an empty baseline and self-registration source', () => {
    const root = scratchRoot();
    const pass = runCli(root, ['--register', 'recovered-session']);
    expect(pass.code).toBe(0);
    const parsed = JSON.parse(readFileSync(join(sessionsDir(root), 'recovered-session.json'), 'utf8'));
    expect(parsed.session_id).toBe('recovered-session');
    expect(parsed.source).toBe('self-registration');
    expect(parsed.baseline).toEqual([]);
  });

  it('refuses an id that sanitizes to nothing — a mangled id must not arm enforcement', () => {
    const root = scratchRoot();
    const pass = runCli(root, ['--register', '///']);
    expect(pass.code).toBe(1);
    expect(existsSync(sessionsDir(root))).toBe(false);
  });

  it('refuses a bare --register with no id — there is deliberately NO discovery mode', () => {
    const root = scratchRoot();
    expect(runCli(root, ['--register']).code).toBe(1);
    expect(runCli(root, []).code).toBe(1);
    expect(existsSync(sessionsDir(root))).toBe(false);
  });
});

// The registry keys on the REPOSITORY, never on the checkout it is read from.
//
// It used to key on the checkout, and that made the child refusal's arming a
// property of HOW a worktree was made (measured 2026-08-30). `git worktree add`
// leaves the gitignored state dir empty, so the registry was unarmed and
// `pre-commit-gate`'s commit/push refusal could not fire — giving a lane its own
// worktree, the correct answer to every other hazard here, was exactly what
// removed the guard. The harness worktree mechanism instead COPIES that dir, so
// the same guard came up ARMED there, on 121 records describing sessions that
// never ran in that checkout. Nothing stated which, and nothing checked it.
//
// The common git dir is shared by every worktree of a repository, so it is the
// identity the registry should have keyed on all along. There is deliberately NO
// fallback to a checkout-local store: a fallback would keep a copied record able
// to arm a worktree, which is the defect itself, softened.
describe('the registry keys on the repository, not on the checkout', () => {
  /** A repository plus one linked worktree made by `git worktree add`. */
  function linkedWorktree(main: string): string {
    const linked = join(main, 'wt');
    const r = spawnSyncHidden('git', ['worktree', 'add', '-q', '-b', 'lap', linked], {
      cwd: main,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    expect(r.status, `${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
    return linked;
  }

  it('arms a linked worktree from the main checkout, so provenance cannot disarm the refusal', () => {
    const main = gitRepo();
    const linked = linkedWorktree(main);
    expect(enforcementArmed(linked)).toBe(false);

    writeSessionRecord(main, record('owner-sid', ['dirt.txt']));

    expect(enforcementArmed(linked)).toBe(true);
    // The owner is recognized in the worktree it dispatched from...
    const owner = readSessionRegistry(linked, 'owner-sid');
    expect(owner.recordState).toBe('ok');
    expect(owner.isUnregisteredChild).toBe(false);
    // ...and an unregistered session in that worktree is a child, as it is at the root.
    expect(readSessionRegistry(linked, 'stranger').isUnregisteredChild).toBe(true);
  });

  it('ignores records that exist ONLY in the checkout — a copied state dir arms nothing', () => {
    const main = gitRepo();
    const linked = linkedWorktree(main);
    // Written to the literal per-checkout path the harness copy would produce,
    // bypassing sessionsDir() so the test states the path rather than trusting it.
    const copied = join(linked, '.claude', 'hooks', '.state', 'sessions');
    mkdirSync(copied, { recursive: true });
    writeFileSync(join(copied, 'ghost.json'), JSON.stringify(record('ghost')));

    expect(enforcementArmed(linked)).toBe(false);
    expect(readSessionRegistry(linked, 'ghost').recordState).toBe('absent');
  });

  it('registers into the repository store, so a worktree session is seen from the root', () => {
    const main = gitRepo();
    const linked = linkedWorktree(main);
    writeSessionRecord(linked, record('worktree-sid'));

    expect(readSessionRegistry(main, 'worktree-sid').recordState).toBe('ok');
    expect(existsSync(join(linked, '.claude', 'hooks', '.state', 'sessions'))).toBe(false);
  });

  it('falls back to the given root outside a repository, so non-repo callers are unchanged', () => {
    const root = scratchRoot();
    expect(sessionsDir(root)).toBe(join(root, '.claude', 'hooks', '.state', 'sessions'));
  });
});
