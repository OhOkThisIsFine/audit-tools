// `runDerivedLeg` is the ONE spawn every derived leg runs under — the commit
// gate's legs and the attest preflight's. Only `execSync` is replaced, so the
// options the leg really runs with are what this test reads.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execSyncSpy = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: execSyncSpy,
}));

const { runDerivedLeg } = await import('../../scripts/shared/derived-file-preflight.mjs');

describe('runDerivedLeg', () => {
  beforeEach(() => execSyncSpy.mockReset());

  it('imposes no deadline and hides the console window', () => {
    // A leg killed at an unmeasured limit reads as a FAILED leg on a slower machine.
    runDerivedLeg({ script: 'check:example' }, { root: '/repo' });
    const [command, options] = execSyncSpy.mock.calls[0];
    expect(command).toBe('npm run check:example');
    expect(options).not.toHaveProperty('timeout');
    expect(options).not.toHaveProperty('env');
    expect(options).toMatchObject({ cwd: '/repo', shell: true, windowsHide: true });
  });

  it('passes the caller env only when given, and rethrows a failed leg', () => {
    const env = { PATH: 'x' };
    // ONCE: the suite's own setup hooks call execSync after the test, through this mock.
    execSyncSpy.mockImplementationOnce(() => {
      throw new Error('leg failed');
    });
    expect(() => runDerivedLeg({ script: 'check:example' }, { root: '/repo', env })).toThrow('leg failed');
    expect(execSyncSpy.mock.calls[0][1].env).toBe(env);
  });
});
