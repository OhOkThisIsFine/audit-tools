/**
 * A script refuses an argument it does not recognize, and never reads an
 * unrecognized flag as consent to do its work.
 *
 * THE INCIDENT (nightly 2026-09-06, friction: tool_should_decide).
 * `node scripts/nightly/ingest-answers.mjs --help` did not print usage — it
 * ingested ten answers and wrote `.claude/nightly-decisions.json`. The flag was
 * ignored rather than refused, and the default action of that script is a
 * durable write. The shape generalizes: an operator reaches for the universal
 * query flag, or mistypes `--dryrun` for `--dry-run`, and the script performs
 * the write the flag was there to ask about.
 *
 * WHAT THIS FILE PINS, and what it deliberately does NOT.
 *
 *   1. The BEHAVIOUR, red-then-green, on every nightly CLI whose default action
 *      writes durable state: a bogus flag exits non-zero naming it, `--help`
 *      prints usage, and neither touches a durable artifact.
 *   2. The PARSE RULE itself (`scripts/shared/argvGuard.mjs`), so the refusal is
 *      single-sourced rather than re-derived per script.
 *   3. The REACH, as a ratchet over the tracked script set: the scripts that
 *      read `process.argv` without the guard are an EXPLICITLY DECLARED set
 *      (`ARGV_GUARD_GAP`), and the test fails when a script appears that is in
 *      neither the guarded set nor that list.
 *
 * The gap is stated rather than implied on purpose. CLAUDE.md's durable-traps
 * rule: a trap enforced only PARTLY is not deletable, and the uncovered half
 * must be written down or the covered half reads as a close. 42 of the tracked
 * scripts read `process.argv` without the guard (measured against HEAD when this
 * landed); migrating them is mechanical but touches gate entry points such as
 * `run-vitest-gate.mjs` and `profile-run.mjs`, which forward variadic arguments,
 * so it is its own change rather than a side effect of the nightly one. Until
 * then the list below is the honest boundary, and the ratchet stops it growing.
 *
 * Lives under tests/ because vitest excludes `.claude/**`.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { parseArgv, refusalMessage, isHelpFlag, USAGE_EXIT } from '../../scripts/shared/argvGuard.mjs';
import { listTrackedScripts, readScriptSource } from '../helpers/tracked-scripts.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const NIGHTLY = (...p: string[]) => join(REPO_ROOT, 'scripts', 'nightly', ...p);

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

/** A throwaway repo root with no ledger and no inbox — a write is observable. */
function emptyRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'argv-refusal-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, '.audit-tools', 'nightly'), { recursive: true });
  return root;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function runScriptCli(cli: string, args: string[], cwd: string): Run {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * The nightly CLIs whose DEFAULT action writes durable state. Each entry names
 * the artifact a bogus flag must not create, so the assertion is "the write did
 * not happen", not merely "the exit code was non-zero" — a script could refuse
 * the flag and write anyway.
 */
const DURABLE_WRITERS: Array<{ cli: string; args: string[]; artifact: string; name: string }> = [
  {
    name: 'ingest-answers',
    cli: NIGHTLY('ingest-answers.mjs'),
    args: ['--root', '.'],
    artifact: '.claude/nightly-decisions.json',
  },
  {
    name: 'answer',
    cli: NIGHTLY('answer.mjs'),
    args: ['DOC-1', 'an answer'],
    artifact: '.claude/nightly-decisions.json',
  },
  {
    name: 'render-inbox',
    cli: NIGHTLY('render-inbox.mjs'),
    args: ['--root', '.'],
    artifact: 'docs/nightly-inbox.md',
  },
];

describe('the reported incident: a query flag must not perform the write', () => {
  it('ingest-answers --help prints usage and writes NOTHING (2026-09-06: it wrote the ledger)', () => {
    const cwd = emptyRoot();
    // Seed a ticked box, so a run that DOES ingest leaves an observable record.
    writeFileSync(
      join(cwd, 'docs', 'nightly-inbox.md'),
      '# inbox\n\n<!-- nightly:item key=abc -->\n\n- [x] **1. Keep it** — keep it\n\n```notes\n\n```\n',
      'utf8',
    );
    const res = runScriptCli(NIGHTLY('ingest-answers.mjs'), ['--help'], cwd);

    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/ingest-answers/);
    expect(
      existsSync(join(cwd, '.claude', 'nightly-decisions.json')),
      'the durable ledger must not exist after a usage query',
    ).toBe(false);
  });

  it.each(DURABLE_WRITERS)(
    '$name refuses an unrecognized flag and performs no write',
    ({ cli, args, artifact }) => {
      const cwd = emptyRoot();
      const res = runScriptCli(cli, [...args, '--bogus-flag-xyz'], cwd);

      expect(res.status, `${cli} should refuse, not run`).toBe(USAGE_EXIT);
      expect(res.stderr).toMatch(/unrecognized argument/i);
      expect(res.stderr).toContain('--bogus-flag-xyz');
      expect(existsSync(join(cwd, artifact)), `${cli} wrote ${artifact} despite refusing`).toBe(false);
    },
  );

  it('render-inbox refuses a mistyped --check rather than performing the write', () => {
    // The real shape of the trap: `--chek` is a query-shaped flag, and the
    // DEFAULT action is a write. Before the guard it rendered the inbox.
    const cwd = emptyRoot();
    const res = runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.', '--chek'], cwd);
    expect(res.status).toBe(USAGE_EXIT);
    expect(res.stderr).toMatch(/unrecognized argument/i);
    expect(existsSync(join(cwd, 'docs', 'nightly-inbox.md'))).toBe(false);
  });

  it('render-inbox --check still works and is read-only', () => {
    // Seed and render a current projection first, so --check's verdict is about
    // freshness and not about a missing file; then prove it wrote nothing.
    const cwd = emptyRoot();
    runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.'], cwd);
    const before = readFileSync(join(cwd, 'docs', 'nightly-inbox.md'), 'utf8');
    const res = runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.', '--check'], cwd);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(readFileSync(join(cwd, 'docs', 'nightly-inbox.md'), 'utf8')).toBe(before);
  });

  it('render-inbox --check reports the ledger disagreement the freshness gate exists for', () => {
    // The 2026-08-27 shape: the tracked queue still asserts an item open after
    // the ledger settles it. Nothing else reconciles the two, so --check must.
    const cwd = emptyRoot();
    runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.'], cwd);
    // Settle a subject the queue is holding, WITHOUT re-rendering.
    writeFileSync(
      join(cwd, '.claude', 'nightly-decisions.json'),
      JSON.stringify({ abc: { disposition: 'settled', answer: 'done', decided_at: '2026-08-27T00:00:00Z' } }),
      'utf8',
    );
    const res = runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.', '--check'], cwd);
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toMatch(/nightly-decisions\.json/);
  });

  it('scope-ledger refuses an unknown flag on a verb that writes the ledger', () => {
    const cwd = emptyRoot();
    const res = runScriptCli(NIGHTLY('scope-ledger.mjs'), ['stamp', 'docs/x.md', '--quiety'], cwd);
    expect(res.status).toBe(USAGE_EXIT);
    expect(res.stderr).toMatch(/unrecognized argument/i);
    expect(existsSync(join(cwd, '.audit-tools', 'nightly', 'scope-ledger.json'))).toBe(false);
  });

  it('scope-ledger refuses an unknown VERB rather than defaulting to plan', () => {
    const cwd = emptyRoot();
    const res = runScriptCli(NIGHTLY('scope-ledger.mjs'), ['plna'], cwd);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/unknown verb/);
  });

  it('review-retirement-candidates refuses a bogus flag rather than enumerating', () => {
    const cwd = emptyRoot();
    const res = runScriptCli(NIGHTLY('review-retirement-candidates.mjs'), ['--retier'], cwd);
    expect(res.status).toBe(USAGE_EXIT);
    expect(res.stderr).toMatch(/unrecognized argument/i);
  });

  it('answer.mjs refuses an undeclared flag in the answer tail rather than recording it', () => {
    // The tension: an answer is free prose that may begin with a dash, but a
    // mistyped flag in the tail must not be absorbed into the ledger as text.
    // The guard resolves it by refusing, and `--` carries genuine dash-prose.
    const cwd = emptyRoot();
    const res = runScriptCli(NIGHTLY('answer.mjs'), ['DOC-1', '--wontfix', '--not worth it'], cwd);
    expect(res.status).toBe(USAGE_EXIT);
    expect(res.stderr).toMatch(/unrecognized argument/i);
    expect(existsSync(join(cwd, '.claude', 'nightly-decisions.json'))).toBe(false);
  });
});

describe('the parse rule (scripts/shared/argvGuard.mjs)', () => {
  it('accepts a declared flag, a declared value and a capped positional', () => {
    const p = parseArgv(['--check', '--root', '/tmp', 'pos'], { flags: ['--check'], values: ['--root'], positionals: 1 });
    expect(p.ok).toBe(true);
    expect(p.has('--check')).toBe(true);
    expect(p.get('--root')).toBe('/tmp');
    expect(p.positionals).toEqual(['pos']);
  });

  it('reports an undeclared flag instead of ignoring it', () => {
    const p = parseArgv(['--nope'], {});
    expect(p.ok).toBe(false);
    expect(p.unknown).toEqual(['--nope']);
  });

  it('reports a positional past the cap rather than swallowing it', () => {
    // `plan --extra` on a verb that takes no arguments: the extra is refused.
    const p = parseArgv(['plan', '--extra'], { positionals: 1 });
    expect(p.ok).toBe(false);
    expect(p.unknown).toEqual(['--extra']);
  });

  it('reports a value flag with nothing after it, rather than reading it as empty', () => {
    const p = parseArgv(['--root'], { values: ['--root'] });
    expect(p.ok).toBe(false);
    expect(p.missingValue).toEqual(['--root']);
  });

  it('recognizes --help and -h as usage, never as work', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(parseArgv(['--help'], {}).help).toBe(true);
    expect(parseArgv(['-h'], {}).help).toBe(true);
  });

  it('treats a bare `-` as a positional, not a flag', () => {
    const p = parseArgv(['-'], { positionals: 1 });
    expect(p.ok).toBe(true);
    expect(p.positionals).toEqual(['-']);
  });

  it('`--` ends flag parsing: the tail is DATA and is never inspected for flags', () => {
    const p = parseArgv(['DOC-1', '--', '--not worth it'], { flags: ['--wontfix'], positionals: Infinity });
    expect(p.ok).toBe(true);
    expect(p.positionals).toEqual(['DOC-1', '--not worth it']);
  });

  it('`--` cannot smuggle a mistyped flag past the guard — pre-separator args are still refused', () => {
    const p = parseArgv(['--nope', '--', 'data'], { positionals: Infinity });
    expect(p.ok).toBe(false);
    expect(p.unknown).toEqual(['--nope']);
  });

  it('renders one refusal message shape, naming every bad argument', () => {
    const msg = refusalMessage(parseArgv(['--a', '--b'], {}), { name: 'x', usage: 'x --help' });
    expect(msg).toContain('unrecognized argument(s) "--a", "--b"');
    expect(msg).toContain('usage: x --help');
  });

  it('renders nothing when there is nothing to refuse', () => {
    expect(refusalMessage(parseArgv([], {}), { name: 'x', usage: 'x' })).toBeNull();
  });
});

describe('reach — the guarded set is a ratchet, and the gap is declared', () => {
  /**
   * The boundary as measured at land time. Each entry still reads `process.argv`
   * and still ignores what it does not recognize; migrating one means deleting
   * its line here, which is the point — the list can only shrink silently if a
   * script stops reading argv entirely, and it cannot grow at all.
   */
  const ARGV_GUARD_GAP = [
    'scripts/attest-constitutional-doc-change.mjs',
    'scripts/check-agents-region.mjs',
    'scripts/check-backlog-budget.mjs',
    'scripts/check-backlog-line-numbers.mjs',
    'scripts/check-backlog-status-tokens.mjs',
    'scripts/check-doc-code-citations.mjs',
    'scripts/check-doc-links.mjs',
    'scripts/check-doc-manifest.mjs',
    'scripts/check-gate-enumeration.mjs',
    'scripts/check-generated-artifacts.mjs',
    'scripts/check-guard-reach.mjs',
    'scripts/check-invariant-glossary.mjs',
    'scripts/check-loader-fragments.mjs',
    'scripts/check-orphan-modules.mjs',
    'scripts/check-philosophy-brief.mjs',
    'scripts/check-readme-sample-report.mjs',
    'scripts/check-shared-primitives.mjs',
    'scripts/check-version-gates.mjs',
    'scripts/release-and-publish.mjs',
    'scripts/remediate/generate-auditor-contract-fixture.mjs',
    'scripts/render-closeout.mjs',
    'scripts/shared/dispatch-load-flake-investigation.mjs',
    'scripts/shared/generate-backlog-index.mjs',
    'scripts/shared/generate-ci-trigger-paths.mjs',
    'scripts/shared/generate-cli-surface.mjs',
    'scripts/shared/generate-constitutional-doc-paths.mjs',
    'scripts/shared/generate-executor-producers.mjs',
    'scripts/shared/generate-filelock-export-surface.mjs',
    'scripts/shared/generate-friction-categories.mjs',
    'scripts/shared/generate-handoff-roadmap.mjs',
    'scripts/shared/generate-ingestion-checks.mjs',
    'scripts/shared/generate-loop-core-patterns.mjs',
    'scripts/shared/generate-runtime-artifact-names.mjs',
    'scripts/shared/generate-spec-mirrors.mjs',
    'scripts/shared/generatedArtifacts.mjs',
    'scripts/shared/guard-no-suite-running.mjs',
    'scripts/shared/profile-run.mjs',
    'scripts/shared/run-vitest-gate.mjs',
    'scripts/shared/sessionRegistry.mjs',
    'scripts/shared/smoke-tarball.mjs',
    'scripts/shared/triage-backlog.mjs',
    'scripts/shared/vitest-timing-reporter.mjs',
    'scripts/shared/vitestShard.mjs',
  ];

  const readsArgv = (source: string) => /process\.argv/.test(source);
  const guarded = (source: string) => /argvGuard\.mjs/.test(source);

  it('every tracked argv-reading script is either guarded or on the declared gap', () => {
    const unlisted: string[] = [];
    for (const rel of listTrackedScripts(REPO_ROOT)) {
      const source = readScriptSource(REPO_ROOT, rel);
      if (!readsArgv(source) || guarded(source)) continue;
      if (!ARGV_GUARD_GAP.includes(rel)) unlisted.push(rel);
    }
    expect(
      unlisted,
      'a script that reads process.argv must adopt scripts/shared/argvGuard.mjs, or be added to ' +
        'ARGV_GUARD_GAP with the reason it cannot — the gap is stated, never implied',
    ).toEqual([]);
  });

  it('the gap only shrinks: every listed script still exists and still needs the guard', () => {
    // A stale entry would let the covered half read as a close. A script that
    // was deleted, or that adopted the guard, must leave the list in the same
    // commit that changed it.
    const stale: string[] = [];
    for (const rel of ARGV_GUARD_GAP) {
      let source: string;
      try {
        source = readScriptSource(REPO_ROOT, rel);
      } catch {
        stale.push(`${rel} (no longer tracked)`);
        continue;
      }
      if (!readsArgv(source)) stale.push(`${rel} (no longer reads process.argv)`);
      else if (guarded(source)) stale.push(`${rel} (now guarded — delete this line)`);
    }
    expect(stale).toEqual([]);
  });

  it('the nightly CLI set is fully guarded', () => {
    const nightly: string[] = listTrackedScripts(REPO_ROOT).filter((p: string) =>
      p.startsWith('scripts/nightly/'),
    );
    expect(nightly.length).toBeGreaterThan(0);
    for (const rel of nightly) {
      const source = readScriptSource(REPO_ROOT, rel);
      if (!readsArgv(source)) continue;
      expect(guarded(source), `${rel} reads process.argv without the shared guard`).toBe(true);
    }
  });

  it('the parse rule has exactly one home — no script re-implements the refusal', () => {
    // `USAGE_EXIT` is the sentinel: a script that hard-codes 2 for a usage
    // refusal instead of importing it is a second copy of the rule.
    const reimplemented: string[] = listTrackedScripts(REPO_ROOT).filter((rel: string) => {
      if (rel === 'scripts/shared/argvGuard.mjs') return false;
      const source = readScriptSource(REPO_ROOT, rel);
      return /unrecognized argument\(s\)/.test(source) && !guarded(source);
    });
    expect(reimplemented).toEqual([]);
  });
});

describe('the guard never breaks a clean invocation', () => {
  it('a declared-but-absent flag leaves the default path intact', () => {
    const cwd = emptyRoot();
    // No --dry-run: the write IS expected here. This is the green half of the
    // pair — proving the refusal did not disable the script's real work.
    const res = runScriptCli(NIGHTLY('render-inbox.mjs'), ['--root', '.'], cwd);
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(existsSync(join(cwd, 'docs', 'nightly-inbox.md'))).toBe(true);
    expect(readFileSync(join(cwd, 'docs', 'nightly-inbox.md'), 'utf8')).toMatch(/Nothing to answer/);
  });
});
