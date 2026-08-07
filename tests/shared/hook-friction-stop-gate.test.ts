// Contract tests for the friction SESSION-LIFECYCLE gate in `.claude/hooks/`.
// Kept under tests/ because vitest excludes `.claude/**`, so a test beside the
// hook never runs in CI.
//
// The gate blocks by exiting 2 with stderr fed back to the agent, and must fail
// OPEN (exit 0) on every fault — a wedged Stop hook cannot be escaped from inside
// the session.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSyncHidden } from '../helpers/spawn.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const FRICTION_GATE = join(REPO_ROOT, '.claude', 'hooks', 'friction-stop-gate.mjs');

interface HookOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

function runHook(
  hook: string,
  payload: unknown,
  { root = REPO_ROOT, env = {}, input = JSON.stringify(payload) }: HookOptions = {},
) {
  const r = spawnSyncHidden(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { code: r.status, stderr: r.stderr ?? '' };
}

const roots: string[] = [];
function tempRoot(label: string): string {
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

const stop = (extra: Record<string, unknown> = {}) => ({ hook_event_name: 'Stop', ...extra });

function markRemediationRun(root: string): string {
  const dir = join(root, '.audit-tools', 'remediation');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), '{}\n');
  return dir;
}

function markAuditRun(root: string): string {
  const dir = join(root, '.audit-tools', 'audit');
  // A substantive run artifact — a bare steps/ dir is NOT a run marker (it is
  // exactly what terminal cleanup leaves behind after promotion re-renders the
  // completed step, so treating it as a run made every post-completion stop
  // block on a record the tool had already archived).
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'repo_manifest.json'), '{}\n');
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

  it('allows a stop when the audit area holds only a steps/ dir (post-terminal-cleanup state)', () => {
    // promoteFinalAuditReport deletes the artifacts dir and the completed-step
    // render recreates steps/ — the only state a finished run leaves. That is
    // not a run needing a walk: the record was archived with the promoted
    // deliverables.
    const root = tempRoot('steps-only');
    const dir = join(root, '.audit-tools', 'audit');
    mkdirSync(join(dir, 'steps'), { recursive: true });
    writeFileSync(join(dir, 'steps', 'current-step.json'), '{}\n');

    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
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

describe('friction-stop-gate: skip in-flight runs', () => {
  it('allows a stop when an area run is visibly in flight (fresh current-step.json)', () => {
    // A concurrent session is actively working on the run (current-step.json
    // was touched within 2 minutes). The bystander must not block it.
    const root = tempRoot('in-flight-remediation');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(
      join(dir, 'friction', 'run.json'),
      JSON.stringify({
        open_observations: [],
        category_attestations: [],
      }),
    );
    // Create a fresh current-step.json (just now).
    mkdirSync(join(dir, 'steps'), { recursive: true });
    writeFileSync(join(dir, 'steps', 'current-step.json'), '{}');

    // The run is recent + has unwalked friction, but current-step.json is
    // fresh → in-flight → allows stop (no block).
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });

  it('blocks when an area run is stale + unwalked (stale current-step.json)', () => {
    // A concurrent session is NOT actively working (current-step.json is stale).
    // This run needs its friction walk — block.
    const root = tempRoot('stale-step');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(
      join(dir, 'friction', 'run.json'),
      JSON.stringify({
        open_observations: [],
        category_attestations: [],
      }),
    );
    // Create a stale current-step.json (over 2 minutes ago).
    mkdirSync(join(dir, 'steps'), { recursive: true });
    const staleTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
    writeFileSync(join(dir, 'steps', 'current-step.json'), '{}');
    // Back-date the file using utimesSync.
    const staleSeconds = staleTime / 1000;
    utimesSync(join(dir, 'steps', 'current-step.json'), staleSeconds, staleSeconds);

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
  });

  it('allows a stop when an area has no current-step.json (not in flight)', () => {
    // current-step.json doesn't exist, so we can't determine if it's in flight.
    // But if the friction walk is complete, the stop is allowed anyway.
    const root = tempRoot('no-step');
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
    // No steps/ dir at all. Friction is complete → allows stop.
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });
});

describe('friction-stop-gate wiring', () => {
  it('is registered under Stop in .claude/settings.json', () => {
    const settings: { hooks: { Stop: Array<{ hooks: unknown[] }> } } = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude', 'settings.json'), 'utf8'),
    );
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
