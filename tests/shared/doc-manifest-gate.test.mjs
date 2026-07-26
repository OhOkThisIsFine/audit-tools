// Contract tests for the doc-gate layer: the doc-manifest reconciliation
// (`scripts/check-doc-manifest.mjs` + `scripts/doc-manifest-data.mjs`) and the
// constitutional-doc refusal in `.claude/hooks/pre-commit-gate.mjs`.
//
// These live under tests/shared (not beside the hook) on purpose: vitest
// EXCLUDES `.claude/**`, so a test placed next to a hook never runs in CI and
// the guard is unverified exactly where it matters — the same reason
// tests/shared/hook-trap-guards.test.mjs lives here.
//
// Each case pins one hole that was live at 0e2eb67b:
//   • reach   — the tracked listing could not see markdown outside `docs/`, so
//               `examples/9router-harness-proxy-setup.md` was tracked, in ZERO
//               rows, and nothing caught it. That file has since been retired;
//               the reach pin names only structurally durable paths, because a
//               pin on a deletable doc goes red when the deletion is CORRECT.
//   • globs   — any pattern containing `*` was DISCARDED, so the `spec/**/*.md`
//               row matched nothing and 22 spec docs were unrouted.
//   • prose   — the registered set was regexed out of the whole guidelines file,
//               so a doc merely MENTIONED counted as registered.
//   • dead    — a row could point at a file deleted months earlier
//               (`meta-audit-log.md` sat dead ~8 weeks).
//   • refusal — the manifest CALLED normative docs escalate-only and commit
//               6fc2e453 rewrote spec/remediate/remediation-goals.md anyway.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSyncHidden, execFileSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  globToRegExp,
  isGlob,
  reconcile,
  renderTable,
  BEGIN_MARKER,
  END_MARKER,
} from '../../scripts/check-doc-manifest.mjs';
import { DOC_MANIFEST } from '../../scripts/doc-manifest-data.mjs';
import {
  CONSTITUTIONAL_DOC_PATHS,
  isConstitutionalDocPath,
} from '../../src/shared/constitutionalDocPaths.ts';
import { renderConstitutionalModule } from '../../scripts/shared/generate-constitutional-doc-paths.mjs';
import { readFileSync } from 'node:fs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const GATE = join(REPO_ROOT, '.claude', 'hooks', 'pre-commit-gate.mjs');

/** Build the guidelines text that `reconcile` will accept for a given manifest. */
const guidelinesFor = (manifest) => `intro\n\n${BEGIN_MARKER}\n\n${renderTable(manifest)}\n\n${END_MARKER}\n`;

describe('glob grammar — the patterns the old checker silently discarded', () => {
  it('`**/` spans any number of segments, including none', () => {
    const re = globToRegExp('spec/**/*.md');
    expect(re.test('spec/host-validation.md')).toBe(true);
    expect(re.test('spec/audit/audit-goals.md')).toBe(true);
    expect(re.test('spec/a/b/c.md')).toBe(true);
    expect(re.test('docs/host-validation.md')).toBe(false);
  });

  it('`*` stays inside one path segment', () => {
    const re = globToRegExp('docs/*.md');
    expect(re.test('docs/HANDOFF.md')).toBe(true);
    expect(re.test('docs/backlog/open-bugs.md')).toBe(false);
  });

  it('`<date>` matches an ISO date plus an optional lap suffix', () => {
    const re = globToRegExp('docs/reviews/*-<date>.md');
    expect(re.test('docs/reviews/backlog-clearance-2026-07-24.md')).toBe(true);
    // The lap-suffix form is real and in-tree — a `?`-free pattern would miss it.
    expect(re.test('docs/reviews/backlog-clearance-2026-07-24b.md')).toBe(true);
    expect(re.test('docs/reviews/undated-note.md')).toBe(false);
    expect(re.test('docs/reviews/nested/thing-2026-07-24.md')).toBe(false);
  });

  it('classifies patterns vs exact paths', () => {
    expect(isGlob('spec/**/*.md')).toBe(true);
    expect(isGlob('docs/reviews/*-<date>.md')).toBe(true);
    expect(isGlob('CLAUDE.md')).toBe(false);
  });
});

describe('reconcile — the manifest holes, driven with synthetic data', () => {
  const row = (over) => ({ type: 't', files: [], check: 'c', autoApply: 'a', ...over });

  it('a doc named only in PROSE is NOT registered (the mention-counts-as-entry hole)', () => {
    // The old checker regexed backticked paths out of the whole file, so a doc
    // mentioned in a row's rationale — `remediation-report.md` was the live case
    // — counted as registered. Rationale now lives in a cell the matcher never
    // reads, so the same mention registers nothing.
    const manifest = [row({ files: ['docs/real.md'], check: 'see also `docs/ghost.md` for context' })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md', 'docs/ghost.md'],
      guidelinesText: guidelinesFor(manifest),
    });
    expect(errors.join('\n')).toMatch(/Stray doc[\s\S]*docs\/ghost\.md/);
  });

  it('a row pointing at a deleted file fails, with or without a `docs/` prefix', () => {
    // `meta-audit-log.md` (no prefix) sat dead in the excluded row ~8 weeks
    // because both extraction regexes REQUIRED `docs/`.
    const manifest = [row({ files: ['docs/real.md', 'meta-audit-log.md'] })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md'],
      guidelinesText: guidelinesFor(manifest),
    });
    expect(errors.join('\n')).toMatch(/no longer exist[\s\S]*meta-audit-log\.md/);
  });

  it('the existence check has NO per-row exemption — the excluded row is checked too', () => {
    // `meta-audit-log.md` lived in the EXCLUDED row, which the old checker
    // exempted from the existence check ("allowed but not required to exist").
    // That exemption is why a deleted file stayed registered for eight weeks.
    const manifest = [row({ type: 'excluded', files: ['docs/real.md', 'docs/gone.md'] })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md'],
      guidelinesText: guidelinesFor(manifest),
    });
    expect(errors.join('\n')).toMatch(/no longer exist[\s\S]*docs\/gone\.md/);
  });

  it('a pattern that matches nothing is a dead routing rule', () => {
    const manifest = [row({ files: ['docs/real.md', 'retired/**/*.md'] })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md'],
      guidelinesText: guidelinesFor(manifest),
    });
    expect(errors.join('\n')).toMatch(/dead routing rule[\s\S]*retired/);
  });

  it('a doc claimed by two rows fails — exactly one row, as the spec claims', () => {
    const manifest = [
      row({ type: 'one', files: ['spec/**/*.md'] }),
      row({ type: 'two', files: ['spec/audit/audit-goals.md'] }),
    ];
    const errors = reconcile({
      manifest,
      onDisk: ['spec/audit/audit-goals.md'],
      guidelinesText: guidelinesFor(manifest),
    });
    expect(errors.join('\n')).toMatch(/more than one manifest row/);
  });

  it('a hand-edited routing table fails until it is regenerated', () => {
    const manifest = [row({ files: ['docs/real.md'] })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md'],
      guidelinesText: `${BEGIN_MARKER}\n\n| Type | Files |\n|---|---|\n| hand | edited |\n\n${END_MARKER}`,
    });
    expect(errors.join('\n')).toMatch(/does not match/);
  });

  it('a missing constitutional doc is reported — the refusal would be a no-op', () => {
    const manifest = [row({ files: ['docs/real.md'] })];
    const errors = reconcile({
      manifest,
      onDisk: ['docs/real.md'],
      guidelinesText: guidelinesFor(manifest),
      constitutionalPaths: ['spec/audit/audit-goals.md'],
    });
    expect(errors.join('\n')).toMatch(/not tracked[\s\S]*audit-goals\.md/);
  });
});

describe('the live manifest reconciles against the whole tracked tree', () => {
  const tracked = execFileSyncHidden('git', ['ls-files', '*.md'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  it('every tracked markdown file in the repo is registered', () => {
    const errors = reconcile({
      manifest: DOC_MANIFEST,
      onDisk: tracked,
      guidelinesText: readFileSync(join(REPO_ROOT, 'docs/doc-review-guidelines.md'), 'utf8'),
      constitutionalPaths: CONSTITUTIONAL_DOC_PATHS,
    });
    expect(errors, errors.join('\n\n')).toEqual([]);
  });

  it('reach extends past `docs/` — the files the old listing could not see', () => {
    // `git ls-files 'docs/*.md' 'docs/**/*.md'` saw none of these.
    // Pin only STRUCTURALLY durable files. This list named a transient doc
    // (`examples/9router-harness-proxy-setup.md`, the hole's original instance);
    // retiring it in 80b59b7b turned a correct deletion into a red suite, because
    // a pin on a doc that is allowed to be deleted tests the doc, not the reach.
    for (const outside of [
      'spec/audit/audit-goals.md',
      'CLAUDE.md',
      'src/audit/README.md',
    ]) {
      expect(tracked, `${outside} must be tracked for this pin to mean anything`).toContain(outside);
    }
    expect(tracked.filter((f) => !f.startsWith('docs/')).length).toBeGreaterThan(30);
  });

  it('the excluded row carries a pattern rule, not an enumeration of dated records', () => {
    const excluded = DOC_MANIFEST.find((r) => r.type === 'excluded');
    const patterns = excluded.files.map((e) => (Array.isArray(e) ? e[0] : e));
    expect(patterns).toContain('docs/reviews/*-<date>.md');
    // No individually-listed dated review record survives.
    expect(patterns.filter((p) => /\d{4}-\d{2}-\d{2}/.test(p) && !p.includes('<date>'))).toEqual([]);
    expect(tracked.filter((f) => f.startsWith('docs/reviews/')).length).toBeGreaterThan(40);
  });
});

describe('constitutional doc paths — single-sourced and parity-pinned', () => {
  it('covers the normative docs the manifest names escalate-only', () => {
    for (const p of [
      'spec/audit/audit-goals.md',
      'spec/remediate/remediation-goals.md',
      'docs/project-philosophy.md',
      'docs/documentation-philosophy.md',
      'CLAUDE.md',
      'AGENTS.md',
    ]) {
      expect(isConstitutionalDocPath(p), `${p} must be constitutional`).toBe(true);
    }
  });

  it('normalizes win32 separators and a leading ./', () => {
    expect(isConstitutionalDocPath('spec\\audit\\audit-goals.md')).toBe(true);
    expect(isConstitutionalDocPath('./CLAUDE.md')).toBe(true);
  });

  it('does NOT over-capture — an over-broad refusal trains the override into a reflex', () => {
    for (const p of ['docs/HANDOFF.md', 'docs/backlog/open-bugs.md', 'README.md', 'spec/host-validation.md']) {
      expect(isConstitutionalDocPath(p), `${p} must not be constitutional`).toBe(false);
    }
  });

  it('is path-sorted and de-duplicated', () => {
    const arr = [...CONSTITUTIONAL_DOC_PATHS];
    expect(arr).toEqual([...new Set(arr)]);
    expect(arr).toEqual([...arr].sort());
  });

  it('the generated hook-side copy is byte-identical to a fresh render', () => {
    // The hooks run pre-build and cannot import the TS source; `--check` in
    // verify:checks is what stops the refusal running against a different list.
    const generated = readFileSync(
      join(REPO_ROOT, 'scripts/shared/constitutional-doc-paths.generated.mjs'),
      'utf8',
    );
    expect(generated).toBe(renderConstitutionalModule([...CONSTITUTIONAL_DOC_PATHS]));
  });
});

// ── the pre-commit gate, end to end in a throwaway repo ──────────────────────
// The gate is spawned as a real process with a real hook payload on stdin — the
// same contract Claude Code uses. Exit 2 = blocked, exit 0 = allowed. The temp
// repo carries a package.json whose gate scripts are no-ops, so the test
// exercises the gate's DECISIONS without running the real 40s typecheck (and
// without ever touching this repo's index).
describe('pre-commit gate — constitutional-doc refusal', () => {
  let repo;

  const git = (args, cwd = repo) =>
    execFileSyncHidden('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

  const writeFile = (rel, body) => {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };

  const runGate = (command = 'git commit -m "wip"') => {
    const r = spawnSyncHidden(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    return { code: r.status, stderr: r.stderr ?? '' };
  };

  const pkg = (over = {}) =>
    JSON.stringify(
      {
        name: 'gate-fixture',
        version: '0.0.0',
        private: true,
        scripts: {
          check: 'node -e ""',
          'test:doc-contract': 'node -e ""',
          'check:doc-manifest': 'node -e ""',
          // Staging `docs/HANDOFF.md` also trips the roadmap-parity trigger; a
          // no-op here keeps these cases about the CONSTITUTIONAL refusal only.
          'check:handoff-roadmap': 'node -e ""',
          ...over,
        },
      },
      null,
      2,
    );

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'audit-tools-doc-gate-'));
    git(['init', '--initial-branch=main']);
    git(['config', 'user.email', 'test@test']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFile('package.json', pkg());
    writeFile('README.md', '# fixture\n');
    // Mirrors the real repo: `.claude/` is ignored, so the override record is
    // invisible to `git status` and survives the gate's staged-snapshot
    // round-trip (which prunes any TRACKED-or-untracked path the staged tree
    // lacks). Without this the fixture would delete the record it just wrote.
    writeFile('.gitignore', '.claude/\nnode_modules/\n');
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
  });

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* windows may hold a handle briefly; a leaked temp dir is not a failure */
    }
  });

  const stage = (rel, body) => {
    writeFile(rel, body);
    git(['add', '-A']);
  };

  const resetWorktree = () => {
    git(['reset', '--hard', 'HEAD']);
    git(['clean', '-fd']);
  };

  it('BLOCKS a commit that rewrites a normative goals doc', () => {
    stage('spec/remediate/remediation-goals.md', '# remediation goals\n\nrewritten to match code\n');
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/CONSTITUTIONAL doc/);
    expect(stderr).toMatch(/spec\/remediate\/remediation-goals\.md/);
    expect(stderr).toMatch(/attest-constitutional-doc-change/);
    resetWorktree();
  });

  it('ALLOWS the same commit once a staged-tree-bound owner-decision record exists', () => {
    stage('spec/audit/audit-goals.md', '# audit goals\n\nowner-approved change\n');
    const sha = git(['write-tree']).trim();
    const dir = join(repo, '.claude', 'constitutional-doc-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sha}.json`),
      JSON.stringify({
        schema_version: 'constitutional-doc-change/v1',
        staged_tree: sha,
        reviewed_by: 'test',
        attester_class: 'human',
        owner_decision: 'owner approved dropping the obligation, decided in the 2026-07-25 hand-back',
        constitutional_files: ['spec/audit/audit-goals.md'],
      }),
      'utf8',
    );
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    resetWorktree();
  });

  it('BLOCKS when the override record binds a DIFFERENT tree (stale)', () => {
    stage('docs/project-philosophy.md', '# philosophy\n\nedited\n');
    const sha = git(['write-tree']).trim();
    const dir = join(repo, '.claude', 'constitutional-doc-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sha}.json`),
      JSON.stringify({
        staged_tree: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        owner_decision: 'a decision recorded against some other tree entirely',
        constitutional_files: ['docs/project-philosophy.md'],
      }),
      'utf8',
    );
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/STALE/);
    resetWorktree();
  });

  it('BLOCKS when the record names no owner decision', () => {
    stage('CLAUDE.md', '# instructions\n\nedited\n');
    const sha = git(['write-tree']).trim();
    const dir = join(repo, '.claude', 'constitutional-doc-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sha}.json`),
      JSON.stringify({ staged_tree: sha, constitutional_files: ['CLAUDE.md'] }),
      'utf8',
    );
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/no owner decision/);
    resetWorktree();
  });

  it('the producer writes a record the gate accepts — round trip, no field drift', () => {
    // Producer and consumer are separate files; a renamed field would leave the
    // refusal permanently un-overridable with no test noticing.
    stage('spec/audit/executor-catalog.md', '# executors\n\nowner-approved change\n');
    const attest = spawnSyncHidden(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'attest-constitutional-doc-change.mjs'),
        '--reviewed-by',
        'test',
        '--attester-class',
        'agent',
        '--owner-decision',
        'owner approved the executor-catalog change in the 2026-07-25 hand-back',
      ],
      { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } },
    );
    expect(attest.status, `${attest.stdout ?? ''}${attest.stderr ?? ''}`).toBe(0);
    expect(attest.stdout).toMatch(/spec\/audit\/executor-catalog\.md/);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    resetWorktree();
  });

  it('the producer refuses without an attester class', () => {
    const r = spawnSyncHidden(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'attest-constitutional-doc-change.mjs'), '--owner-decision', 'x'.repeat(30)],
      { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, CLAUDE_PROJECT_DIR: repo } },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--attester-class is REQUIRED/);
  });

  it('does NOT fire on an ordinary doc — the refusal stays narrow', () => {
    stage('docs/HANDOFF.md', '# handoff\n\nnext steps\n');
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    resetWorktree();
  });
});

describe('pre-commit gate — the doc-manifest trigger reaches past docs/', () => {
  let repo;

  const git = (args) => execFileSyncHidden('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });

  const writeFile = (rel, body) => {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf8');
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'audit-tools-doc-trigger-'));
    execFileSyncHidden('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: 'pipe' });
    git(['config', 'user.email', 'test@test']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    // `check:doc-manifest` FAILS here, so the gate blocking proves it ran.
    writeFile(
      'package.json',
      JSON.stringify(
        {
          name: 'trigger-fixture',
          version: '0.0.0',
          private: true,
          scripts: {
            check: 'node -e ""',
            'test:doc-contract': 'node -e ""',
            'check:doc-manifest': 'node -e "process.exit(1)"',
          },
        },
        null,
        2,
      ),
    );
    writeFile('README.md', '# fixture\n');
    git(['add', '-A']);
    git(['commit', '-m', 'base']);
  });

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const runGate = () => {
    const r = spawnSyncHidden(process.execPath, [GATE], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m "wip"' } }),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });
    return { code: r.status, stderr: r.stderr ?? '' };
  };

  it('runs the doc-manifest check for markdown OUTSIDE docs/', () => {
    // The trigger was `^docs/.*\.md$` — narrower than the check it fires, which
    // is how an unregistered `examples/…md` could be staged with nothing to
    // notice. A trigger narrower than its check plants violations for CI.
    writeFile('examples/some-setup.md', '# setup\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(/doc-manifest check FAILED/);
    git(['reset', '--hard', 'HEAD']);
    git(['clean', '-fd']);
  });

  it('still ignores a commit that carries no markdown at all', () => {
    writeFile('src/thing.ts', 'export const x = 1;\n');
    git(['add', '-A']);
    const { code, stderr } = runGate();
    expect(code, stderr).toBe(0);
    git(['reset', '--hard', 'HEAD']);
    git(['clean', '-fd']);
  });
});
