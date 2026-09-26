#!/usr/bin/env node
// sites-pinned: tests/shared/gate-catalog-single-declaration.test.ts, tests/audit/a7.test.ts
// The one executable gate catalog, in runner form (packet 22): the release
// execution of every `gate` is DERIVED from `scripts/guard-reach-data.mjs`
// `GUARDS` — the ordered declaration that owns identity, command, release
// phase, reach, pre-commit policy and the concise remedy. This module is what
// `verify:checks` and `verify:release` (package.json) actually run.
//
// One declaration to add or remove a gate:
//   - a `gate` row declared `release: 'default'` (or with no `release` field)
//     is a `verify:checks` step, in GUARDS order;
//   - a `gate` row declared `release: 'tail'` runs AFTER the default sequence
//     and only under `verify:release` — the vitest suite and the two
//     linked-install smokes, which were never inside `verify:checks` before and
//     must stay out of it (a commit/pre-tag gate never runs the full suite).
// Order, fail-fast behaviour and the build/smoke phase order are preserved
// because the default sequence IS the `verify:checks` order, byte-for-byte the
// order the old hand-written list carried.
//
// Execution goes through `runProfiledCommands` (scripts/shared/profile.mjs),
// the same fail-fast, per-step-timed runner the retired `profile-run.mjs` used,
// so the profile ledger (`verify-checks-latest.json`, the GHA job summary) and
// the "one subprocess per step, first non-zero step stops" semantics are
// unchanged. There is no separate membership/order list to drift from this
// declaration — the parity machinery this replaced existed only because the
// step list was hand-accreted beside the registry.
import { npmCommand, runProfiledCommands } from './profile.mjs';
import { guardArgv } from './argvGuard.mjs';
import { GUARDS } from '../guard-reach-data.mjs';

/**
 * The ordered release gates, split into the two phases the runners need.
 * Derived from GUARDS, never hand-listed: a gate joins or leaves the release
 * when its row is added or removed.
 * @param {Array<{kind?: string, impl?: string, release?: string}>} [guards]
 * @returns {{ default: string[], tail: string[] }}
 */
export function releaseGatePhases(guards = GUARDS) {
  const gateRows = guards.filter((g) => g.kind === 'gate' && typeof g.impl === 'string');
  return {
    default: gateRows.filter((g) => g.release !== 'tail').map((g) => /** @type {string} */ (g.impl)),
    tail: gateRows.filter((g) => g.release === 'tail').map((g) => /** @type {string} */ (g.impl)),
  };
}

async function main() {
  const { tail = false } = guardArgv(process.argv.slice(2), {
    name: 'run-release-gates',
    usage: 'node scripts/shared/run-release-gates.mjs [--tail]',
    flags: ['--tail'],
  });

  const phases = releaseGatePhases();
  const scripts = tail
    ? [...phases.default, ...phases.tail]
    : phases.default;

  const npm = npmCommand();
  await runProfiledCommands(
    tail ? 'verify-release' : 'verify-checks',
    scripts.map((s) =>
      s.includes('/')
        ? { label: s, command: process.execPath, args: [s] }
        : { label: s, command: npm, args: ['run', '--silent', s] },
    ),
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (invokedDirectly) main();
