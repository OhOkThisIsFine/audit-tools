import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseArgv, refusalMessage, isHelpFlag } from '../../scripts/shared/argvGuard.mjs';
import { listTrackedScripts, readScriptSource } from '../helpers/tracked-scripts.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
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
    'scripts/check-backlog-budget.mjs',
    'scripts/check-backlog-line-numbers.mjs',
    'scripts/check-backlog-status-tokens.mjs',
    'scripts/check-doc-code-citations.mjs',
    'scripts/check-doc-links.mjs',
    'scripts/check-doc-manifest.mjs',
    'scripts/check-generated-artifacts.mjs',
    'scripts/check-invariant-glossary.mjs',
    'scripts/check-loader-fragments.mjs',
    'scripts/remediate/smoke-remediate-gate.mjs',
    'scripts/check-philosophy-brief.mjs',
    'scripts/check-readme-sample-report.mjs',
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

  // Checking Node's entry filename consumes no user-supplied CLI option.
  const readsArgv = (source: string) =>
    /process\.argv/.test(source.replaceAll('isScriptEntry(import.meta.url, process.argv)', ''));

  it('entry identity alone consumes no user arguments, but an additional option read still counts', () => {
    const entry = 'if (isScriptEntry(import.meta.url, process.argv)) main();';
    expect(readsArgv(entry)).toBe(false);
    expect(readsArgv(entry + '\nmain(process.argv.slice(2));')).toBe(true);
  });
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
