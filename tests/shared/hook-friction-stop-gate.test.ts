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
  // Scrub the child/dispatch env before every spawn: a dispatched child session
  // carries AUDIT_TOOLS_CHILD_SESSION=1 (and may carry the git allow token) —
  // inherited, either would flip behavior these tests pin. A case testing one
  // re-adds it via `env`.
  const inherited = { ...process.env };
  delete inherited.AUDIT_TOOLS_CHILD_SESSION;
  delete inherited.LLM_RELAY_DISPATCH_DEPTH;
  delete inherited.AUDIT_TOOLS_AGENT_GIT;
  const r = spawnSyncHidden(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...inherited, CLAUDE_PROJECT_DIR: root, ...env },
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

/**
 * Render the run's persisted step contract naming its ONE friction record — the
 * artifact both orchestrator halves write whenever a run owes a walk
 * (`artifact_paths.friction_record`). The gate reads the record from HERE, so a
 * fixture that wants the gate to look at a record must state the path the way
 * the tool does.
 *
 * The path is written as the tool writes it: a root-relative, forward-slash
 * token. It is deliberately the fixture's OWN choice of name — the gate must
 * follow the contract, never a filename convention.
 */
function writeStepContractNamingRecord(
  areaDir: string,
  recordPath: string,
  { stale = true }: { stale?: boolean } = {},
): void {
  mkdirSync(join(areaDir, 'steps'), { recursive: true });
  const file = join(areaDir, 'steps', 'current-step.json');
  writeFileSync(
    file,
    JSON.stringify({
      step_kind: 'close_run',
      status: 'ready',
      artifact_paths: { friction_record: recordPath },
    }),
  );
  // A contract written "just now" reads as an IN-FLIGHT run and is skipped by
  // the gate's bystander guard. Default to stale: the fixtures here model a run
  // that has stopped churning with its walk still unclaimed — the case the
  // backstop exists for. The in-flight cases opt back in with `stale: false`.
  if (stale) {
    const old = (Date.now() - 3 * 60 * 1000) / 1000;
    utimesSync(file, old, old);
  }
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
  it('blocks a recent remediation run whose named record is missing', () => {
    const root = tempRoot('remediation');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
    expect(stderr).toContain('ambiguous_direction');
    expect(stderr).toContain('tool_should_decide');
    expect(stderr).toContain('inefficient_feeding');
  });

  it('blocks a recent audit run whose named record is missing', () => {
    const root = tempRoot('audit');
    const dir = markAuditRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/audit/friction/run.json');

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
      join(dir, 'friction', 'plan-1.json'),
      JSON.stringify({
        open_observations: [{ category: 'ambiguous_direction' }],
        category_attestations: [
          { category: 'tool_should_decide', disposition: 'none' },
          { category: 'inefficient_feeding', disposition: 'none' },
        ],
      }),
    );
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });

  it('allows a re-entrant stop after the gate has already blocked once', () => {
    const root = tempRoot('reentrant');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(join(dir, 'friction', 'plan-1.json'), JSON.stringify({ open_observations: [] }));

    expect(runHook(FRICTION_GATE, stop({ stop_hook_active: true }), { root }).code).toBe(0);
  });

  it('allows a stop while background tasks are live — the walk is owed at the real close', () => {
    const root = tempRoot('live-bg');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(join(dir, 'friction', 'plan-1.json'), JSON.stringify({ open_observations: [] }));

    const live = stop({ background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] });
    expect(runHook(FRICTION_GATE, live, { root }).code).toBe(0);
  });

  it('still blocks when every background task is terminal', () => {
    const root = tempRoot('terminal-bg');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    const harvested = stop({ background_tasks: [{ id: 'a1', type: 'shell', status: 'completed' }] });
    expect(runHook(FRICTION_GATE, harvested, { root }).code).toBe(2);
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

describe('friction-stop-gate reads the ONE record the run named (F3)', () => {
  // RED PROOF. The gate's former rule was "any complete *.json under
  // <area>/friction satisfies the walk". That accepts ANOTHER run's record: a
  // complete sibling silences the gate for a run whose own walk was never done.
  // Here a complete record sits under a name the contract does NOT name, beside
  // an INCOMPLETE record the contract DOES name. The gate must block.
  //
  // Red with the fix inverted: restoring the scan (accepting any complete
  // record) turns this into exit 0.
  it('blocks when a complete record exists under a name the run did not name', () => {
    const root = tempRoot('sibling-complete');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });

    // A sibling run's record, complete — but not this run's.
    writeFileSync(
      join(dir, 'friction', 'someone-elses-run.json'),
      JSON.stringify({
        open_observations: [{ category: 'ambiguous_direction' }],
        category_attestations: [
          { category: 'tool_should_decide', disposition: 'none' },
          { category: 'inefficient_feeding', disposition: 'none' },
        ],
      }),
    );
    // THIS run's record, named by its contract, walked only partly.
    writeFileSync(
      join(dir, 'friction', 'plan-1.json'),
      JSON.stringify({ open_observations: [{ category: 'ambiguous_direction' }] }),
    );
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
  });

  it('allows a stop when the named record is complete', () => {
    const root = tempRoot('named-complete');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(
      join(dir, 'friction', 'plan-1.json'),
      JSON.stringify({
        open_observations: [{ category: 'ambiguous_direction' }],
        category_attestations: [
          { category: 'tool_should_decide', disposition: 'none' },
          { category: 'inefficient_feeding', disposition: 'none' },
        ],
      }),
    );
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });

  it('blocks when the named record is absent, however many siblings exist', () => {
    const root = tempRoot('named-absent');
    const dir = markRemediationRun(root);
    mkdirSync(join(dir, 'friction'), { recursive: true });
    writeFileSync(
      join(dir, 'friction', 'stale-other.json'),
      JSON.stringify({
        open_observations: [{ category: 'ambiguous_direction' }],
        category_attestations: [
          { category: 'tool_should_decide', disposition: 'none' },
          { category: 'inefficient_feeding', disposition: 'none' },
        ],
      }),
    );
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');

    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(2);
  });

  it('allows a stop when no step contract names a record — no walk is owed', () => {
    const root = tempRoot('no-contract');
    markRemediationRun(root);
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
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
      join(dir, 'friction', 'plan-1.json'),
      JSON.stringify({
        open_observations: [],
        category_attestations: [],
      }),
    );
    // A fresh current-step.json (just now) naming the run's record.
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json', {
      stale: false,
    });

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
      join(dir, 'friction', 'plan-1.json'),
      JSON.stringify({
        open_observations: [],
        category_attestations: [],
      }),
    );
    // A stale current-step.json (over 2 minutes ago), naming the run's record.
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');
    const staleTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
    // Back-date the file using utimesSync.
    const staleSeconds = staleTime / 1000;
    utimesSync(join(dir, 'steps', 'current-step.json'), staleSeconds, staleSeconds);

    const { code, stderr } = runHook(FRICTION_GATE, stop(), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
  });

  it('allows a stop when the run rendered no step contract (no walk owed)', () => {
    // A marker alone is not a walk: the run states which record it owes through
    // its persisted step contract. With no contract, there is no record to
    // check and nothing to block on — the same fail-open reading that keeps a
    // stub or a post-promotion `steps/`-only tree from nagging forever.
    const root = tempRoot('no-step');
    markRemediationRun(root);
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(0);
  });
});

// Build 1 (P23): a child session's stop must not be recruited into the friction
// walk — an unregistered session under an ARMED registry exits 0 silently.
describe('friction-stop-gate: unregistered-child skip (Build 1)', () => {
  async function arm(root: string, ...ids: string[]): Promise<void> {
    // The lib's own writer — the same write path the SessionStart leg uses, so
    // this fixture can never drift from the frozen record shape.
    const lib = await import('../../scripts/shared/sessionRegistry.mjs');
    for (const id of ids) {
      lib.writeSessionRecord(root, {
        version: 1,
        session_id: id,
        registered_at: new Date().toISOString(),
        source: 'test',
        baseline: [],
      });
    }
  }

  it("skips an unregistered session under an armed registry — the child's stop is not recruited", async () => {
    const root = tempRoot('child-skip');
    markRemediationRun(root);
    await arm(root, 'resident-owner');
    expect(runHook(FRICTION_GATE, stop({ session_id: 'stranger' }), { root }).code).toBe(0);
  });

  it('a REGISTERED session still owes its friction walk', async () => {
    const root = tempRoot('registered-walk');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');
    await arm(root, 'resident-owner');
    const { code, stderr } = runHook(FRICTION_GATE, stop({ session_id: 'resident-owner' }), { root });
    expect(code).toBe(2);
    expect(stderr).toContain('recent remediate-code run');
  });

  it("no session_id in the payload → legacy behavior even when armed (Build 3's no-id pin)", async () => {
    const root = tempRoot('no-sid');
    const dir = markRemediationRun(root);
    writeStepContractNamingRecord(dir, '.audit-tools/remediation/friction/plan-1.json');
    await arm(root, 'resident-owner');
    expect(runHook(FRICTION_GATE, stop(), { root }).code).toBe(2);
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
