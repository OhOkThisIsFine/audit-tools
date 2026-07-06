// Seeded fixture repository for the A-9 autonomy acceptance capstone
// (`tests/audit/a9.test.mjs`).
//
// The capstone drives audit → promote → remediate end-to-end IN-PROCESS over a
// real backend provider with ZERO host-subagent dispatch. For that to be a real
// (non-vacuous) test, the fixture must contain a REAL, PLANTABLE defect that:
//
//   1. an audit pass can find and report as a finding, and
//   2. a remediation worker can actually FIX with a concrete code change, whose
//      fix is VERIFIABLE by a deterministic, space-tokenised `targeted_command`
//      that fails before the fix and passes after it.
//
// The plant is a clamp helper that returns the wrong bound on the upper-bound
// path (`> max` returns `min` instead of `max`). The bundled self-check script
// asserts the correct clamp behaviour, so it exits non-zero against the buggy
// source and zero once the worker restores the correct `return max`. The verify
// command is a single `node <script>` invocation — every token is space-free, as
// `verifyNodeInWorktree` splits commands on spaces.
//
// Everything here is hermetic: a local git repo with a base commit, no network,
// no GitHub, no PR.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSyncHidden as spawnSync } from "../../helpers/spawn.mjs";

/** The relative path of the file carrying the plantable defect. */
export const DEFECT_FILE = 'src/clamp.mjs';

/** The relative path of the deterministic self-check the fix must satisfy. */
export const VERIFY_SCRIPT = 'check-clamp.mjs';

/**
 * The single, space-free verify command for the defect's remediation node. Run
 * inside the node's worktree by the rolling engine's per-node verify; it fails
 * against the buggy source and passes once the upper-bound branch is corrected.
 */
export const DEFECT_VERIFY_COMMAND = `node ${VERIFY_SCRIPT}`;

/**
 * Write the seeded fixture's working tree into `root` (no git yet).
 *
 * The clamp helper has a single deterministic bug on the upper-bound branch.
 * The self-check script is the source of truth for "fixed": it exercises the
 * lower bound, the in-range pass-through, and the upper bound, and exits 1 on
 * any mismatch.
 */
export async function writeAutonomyFixtureTree(root) {
  await mkdir(join(root, 'src'), { recursive: true });

  // `check` runs the dependency-free self-check via plain node. The in-process
  // rolling driver's per-node verify always runs `npm run check` (its build-free
  // baseline); pointing that at `node check-clamp.mjs` keeps the verify hermetic
  // — no toolchain / node_modules in the worktree, fails on the bug, passes on the
  // fix.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'autonomy-fixture-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: {
          check: 'node check-clamp.mjs',
        },
      },
      null,
      2,
    ) + '\n',
  );

  // The plantable defect: the `value > max` branch returns `min` (wrong) instead
  // of `max`. A correctness/security audit lens flags it; a worker fixes the one
  // wrong return.
  await writeFile(
    join(root, DEFECT_FILE),
    [
      '// Clamp a number into the inclusive [min, max] range.',
      'export function clamp(value, min, max) {',
      '  if (value < min) {',
      '    return min;',
      '  }',
      '  if (value > max) {',
      '    // BUG: the upper-bound branch must return `max`, not `min`.',
      '    return min;',
      '  }',
      '  return value;',
      '}',
      '',
    ].join('\n'),
  );

  // Deterministic self-check: exits 0 only when clamp is correct on every branch.
  await writeFile(
    join(root, VERIFY_SCRIPT),
    [
      "import { clamp } from './src/clamp.mjs';",
      '',
      'const cases = [',
      '  [5, 0, 10, 5],',
      '  [-3, 0, 10, 0],',
      '  [42, 0, 10, 10],',
      '];',
      '',
      'for (const [value, min, max, expected] of cases) {',
      '  const actual = clamp(value, min, max);',
      '  if (actual !== expected) {',
      '    console.error(',
      '      `clamp(${value}, ${min}, ${max}) = ${actual}, expected ${expected}`,',
      '    );',
      '    process.exit(1);',
      '  }',
      '}',
      '',
      "console.log('clamp ok');",
      '',
    ].join('\n'),
  );
}

/**
 * Initialise a git repo at `root` with an isolated identity and a single base
 * commit containing the seeded (still-buggy) tree. Worktree-based remediation
 * needs a real repo with at least one commit to branch from.
 *
 * Throws if any git step fails so a broken fixture surfaces immediately rather
 * than as a confusing downstream assertion.
 */
export function initAutonomyFixtureGit(root) {
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });

  const steps = [
    ['init'],
    ['config', 'user.email', 'autonomy-fixture@example.com'],
    ['config', 'user.name', 'autonomy-fixture'],
    // Pin the initial branch name so branch discovery is deterministic regardless
    // of the host's git `init.defaultBranch`.
    ['checkout', '-B', 'main'],
    ['add', '-A'],
    ['commit', '-m', 'seed: clamp fixture with plantable upper-bound defect'],
  ];
  for (const args of steps) {
    const r = git(...args);
    if (r.status !== 0) {
      throw new Error(
        `autonomy fixture git ${args.join(' ')} failed: ${r.stderr || r.stdout || `status ${r.status}`}`,
      );
    }
  }
  return { git, baseBranch: 'main' };
}

/**
 * The structured audit-findings.json the capstone promotes when it drives
 * remediation directly from a known finding (the "promote" half of
 * audit → promote → remediate). Mirrors the shape of a real promoted contract:
 * one high-severity finding citing the defect file, with a verifiable
 * `targeted_command` so the remediation node's per-node verify is deterministic.
 *
 * Using a fixed contract (rather than whatever the live audit happens to surface)
 * keeps the remediation half's denominator and verify command deterministic — the
 * audit half is still exercised separately by `runAuditHalf` in the test.
 */
export function buildPromotedFindings() {
  return {
    contract_version: 'audit-code-findings/v1alpha1',
    generated_at: new Date(0).toISOString(),
    summary: { finding_count: 1 },
    findings: [
      {
        id: 'AUTONOMY-CLAMP-1',
        title: 'clamp() returns the wrong bound on the upper-bound branch',
        category: 'correctness',
        severity: 'high',
        confidence: 'high',
        lens: 'correctness',
        summary:
          'In src/clamp.mjs the `value > max` branch returns `min` instead of `max`, ' +
          'so any value above the range is clamped to the wrong end.',
        affected_files: [{ path: DEFECT_FILE, line_start: 6, line_end: 8 }],
        evidence: [`${DEFECT_FILE}:7 - upper-bound branch returns min`],
        recommendation:
          'Return `max` from the `value > max` branch so the value is clamped to the ' +
          'inclusive upper bound.',
        targeted_commands: [DEFECT_VERIFY_COMMAND],
      },
    ],
    work_blocks: [],
  };
}
