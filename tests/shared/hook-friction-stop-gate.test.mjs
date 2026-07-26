// Contract tests for the friction SESSION-LIFECYCLE gate in `.claude/hooks/`.
// Kept under tests/ because vitest excludes `.claude/**`, so a test beside the
// hook never runs in CI.
//
// The gate blocks by exiting 2 with stderr fed back to the agent, and must fail
// OPEN (exit 0) on every fault — a wedged Stop hook cannot be escaped from inside
// the session.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FRICTION_GATE = join(REPO_ROOT, '.claude', 'hooks', 'friction-stop-gate.mjs');

function runHook(hook, payload, { root = REPO_ROOT, env = {}, input = JSON.stringify(payload) } = {}) {
  const r = spawnSyncHidden(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

const roots = [];
function tempRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `friction-gate-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* windows lock — leave it to the temp reaper */
    }
  }
});

const stop = (extra = {}) => ({ hook_event_name: 'Stop', ...extra });

function markRemediationRun(root) {
  const dir = join(root, '.audit-tools', 'remediation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}\n');
  return dir;
}

function markAuditRun(root) {
  const dir = join(root, '.audit-tools', 'audit');
  mkdirSync(join(dir, 'steps'), { recursive: true });
  return dir;
}

describe('friction-stop-gate: recent runs complete the friction close-out walk', () => {
  it('blocks a recent remediation run with no friction walk', () => {
    const root = tempRoot('remediation');
    markRemediationRun(root);

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
    expect(stderr).toContain('ambiguous_direction');
    expect(stderr).toContain('tool_should_decide');
    expect(stderr).toContain('inefficient_feeding');
  });

  it('blocks a recent audit run with no friction walk', () => {
    const root = tempRoot('audit');
    markAuditRun(root);

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent audit-code run');
  });

  it('allows a recent run when observations and attestations cover every category', () => {
    const root = tempRoot('complete');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(
      join(dir, 'friction', 'run.json'),
      JSON.stringify({
        open_observations: [{ category: 'ambiguous_direction' }],
        category_attestations: [
          { category: 'tool_should_decide', disposition: 'none' },
          { category: 'inefficient_feeding', disposition: 'none' },
        ],
      }),
    );

    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });

  it('allows a re-entrant stop after the gate has already blocked once', () => {
    const root = tempRoot('reentrant');
    markRemediationRun(root);

    expect(runHook(FRICTION_GATE, stop({ stop_hook_active: true }), { root }).code).toBe(0);
  });

  it('honours the kill switch', () => {
    const root = tempRoot('kill');
    markRemediationRun(root);

    const r = runHook(FRICTION_GATE, stop(), {
      root,
      env: { AUDIT_TOOLS_NO_FRICTION_STOP_GATE: '1' },
    });
    expect(r.code).toBe(0);
  });

  it('fails OPEN when no hook payload is provided', () => {
    const root = tempRoot('empty-input');
    expect(runHook(FRICTION_GATE, undefined, { root }).code).toBe(0);
  });

  it('fails OPEN when the hook payload is unreadable JSON', () => {
    const root = tempRoot('bad-input');
    expect(runHook(FRICTION_GATE, undefined, { root, input: '{not-json' }).code).toBe(0);
  });

  it('fails OPEN when the project inputs are missing', () => {
    const root = tempRoot('missing');
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });

  it('fails OPEN when the project root is not a readable directory tree', () => {
    const root = tempRoot('unreadable');
    const file = join(root, 'not-a-directory');
    writeFileSync(file, 'not a project root\n');
    expect(runHook(FRICTION_GATE, stop(), { root: file }).code).toBe(0);
  });
});

describe('friction-stop-gate wiring', () => {
  it('is registered under Stop in .claude/settings.json', () => {
    const settings = JSON.parse(readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'));
    const stopHooks = settings.hooks.Stop.flatMap((entry) => entry.hooks);

    expect(stopHooks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'command',
          command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/friction-stop-gate.mjs"',
        }),
      ]),
    );
  });
});
