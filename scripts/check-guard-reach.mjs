#!/usr/bin/env node
//
// Guard-reach reconciliation gate (nightly determination ec64d159).
//
// The defect class: a guard that sounds general covers only part of what it
// names — and because nothing fails on the uncovered part, it reads as
// protected. Six recorded instances on five dates (loop-core gate vs the CLI
// step-emitters; pre-commit gate firing only on `git commit`; a smoke script in
// no gate; a forbidden command pinned in one file; the vi.spyOn barrel guard
// scanning one of three test dirs; no refusal of a direct child_process.spawn).
// The prior control was prose: durable-traps.md REQUIRING the uncovered half be
// stated — a memory-based rule, which is the shape this repo bans.
//
// The mechanism is check-doc-manifest.mjs applied to guards. Reach is DECLARED
// DATA in `scripts/guard-reach-data.mjs`:
//   • GUARDS — every guard implementation and how it is wired (an npm gate
//     reachable from verify:release, a hook registered in .claude/settings.json,
//     or a contract test under tests/),
//   • REACH  — which guard ids claim which tracked files, with deliberate gaps
//     declared as `guardedBy: 'declared-gap'` rows and every known uncovered
//     half stated in `uncovered` as data.
// This gate reconciles the declaration against the tracked tree, package.json
// and .claude/settings.json, making four silent states loud:
//   1. a tracked file no row claims (the `scripts/`-has-no-tsconfig shape),
//   2. a guard wired into no gate ("a script in no gate is not a gate"),
//   3. a registered hook / check script / check:* npm script with no registry
//      row (bidirectional — a new guard cannot land outside the registry),
//   4. registry rot (dead patterns, phantom guard ids, duplicates).
//
// SEMANTICS, deliberately narrow: a `guardedBy` claim means "this guard
// actually scans/executes these files", never "these files are protected from
// every defect class". The reconciler verifies existence and wiring, not guard
// internals — a row's stated reach can still be narrower than its guard's name,
// which is exactly what the mandatory-honesty `uncovered` field is for.
//
//   node scripts/check-guard-reach.mjs        # verify
//
// The reconciliation logic is exported as a library (driven by
// tests/shared/guard-reach-gate.test.ts with synthetic registries); the CLI
// body runs only on direct invocation.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isGlob, globToRegExp } from './check-doc-manifest.mjs';
import { GUARDS, REACH } from './guard-reach-data.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = 'scripts/guard-reach-data.mjs';

// win32: forward-slash everything before any comparison — `git ls-files` emits
// `/`, but settings.json commands and hand-typed rows may carry `\`.
const norm = (p) => p.replace(/\\/g, '/');

const matcherFor = (pattern) => (isGlob(pattern) ? globToRegExp(pattern) : null);
const matches = (pattern, matcher, file) => (matcher ? matcher.test(file) : pattern === file);

/**
 * Expand the npm-script reachability closure from `verify:release`: follow
 * `npm run <name>` references and the gate names listed as arguments to
 * profile-run.mjs. Returns the visited script names.
 */
function reachableScripts(packageScripts, root = 'verify:release') {
  const visited = new Set();
  const stack = [root];
  while (stack.length) {
    const name = stack.pop();
    if (visited.has(name) || !(name in packageScripts)) continue;
    visited.add(name);
    const cmd = packageScripts[name];
    for (const m of cmd.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)) stack.push(m[1]);
    if (cmd.includes('profile-run.mjs')) {
      // `profile-run.mjs <label> <script> <script> …` — every arg after the
      // label that names a package script is an edge.
      for (const token of cmd.split(/\s+/)) {
        if (token in packageScripts) stack.push(token);
      }
    }
  }
  return visited;
}

/**
 * Reconcile the guard registry against the tracked tree. Pure — takes the file
 * list, the package.json scripts object and the settings.json hook command
 * strings; returns error strings (empty = clean).
 */
export function reconcile({ guards, reach, onDisk, packageScripts, settingsHookCommands }) {
  const errors = [];
  const files = onDisk.map(norm);
  const hookCommands = settingsHookCommands.map(norm);

  // ── registry integrity ─────────────────────────────────────────────────────
  const ids = new Map();
  for (const g of guards) ids.set(g.id, (ids.get(g.id) ?? 0) + 1);
  const dupes = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
  if (dupes.length) {
    errors.push(`Duplicate guard id(s) in ${DATA_FILE}:\n` + dupes.map((d) => `  - ${d}`).join('\n'));
  }
  const phantom = [];
  for (const row of reach) {
    if (row.guardedBy === 'declared-gap') continue;
    for (const id of row.guardedBy) {
      if (!ids.has(id)) phantom.push(`${row.area} → ${id}`);
    }
  }
  if (phantom.length) {
    errors.push(
      `Reach row(s) cite guard id(s) with no GUARDS row (${DATA_FILE}):\n` +
        phantom.map((p) => `  - ${p}`).join('\n'),
    );
  }

  // ── preCommit flag discipline (P34) ────────────────────────────────────────
  // The pre-commit hook's leg set is DERIVED from this registry
  // (scripts/shared/derived-file-preflight.mjs `buildPreCommitLegs`), so every
  // gate must STATE its pre-commit behavior — false is a deliberate CI-only
  // decision as data, never an omission. A 'reach'/'final' gate cited by zero
  // REACH rows has an empty trigger and can never fire: a dead flag that reads
  // as coverage.
  const PRECOMMIT_VALUES = new Set([false, 'reach', 'always', 'final']);
  const citedGateIds = new Set(
    reach.flatMap((row) => (row.guardedBy === 'declared-gap' ? [] : row.guardedBy)),
  );
  for (const g of guards) {
    if (g.kind === 'gate') {
      if (!('preCommit' in g)) {
        errors.push(
          `Gate guard "${g.id}" declares no preCommit flag — the pre-commit leg set is derived from ` +
            `this registry, so omission must be a statement (preCommit: false), never silence. (${DATA_FILE})`,
        );
      } else if (!PRECOMMIT_VALUES.has(g.preCommit)) {
        errors.push(
          `Gate guard "${g.id}" has invalid preCommit value ${JSON.stringify(g.preCommit)} — ` +
            `expected false | 'reach' | 'always' | 'final'.`,
        );
      } else if ((g.preCommit === 'reach' || g.preCommit === 'final') && !citedGateIds.has(g.id)) {
        errors.push(
          `Gate guard "${g.id}" is preCommit:'${g.preCommit}' but no REACH row cites it — a ` +
            `reach-triggered leg with no reach can never fire. Cite it from the row(s) it actually ` +
            `scans, or set preCommit: false.`,
        );
      }
    } else if ((g.kind === 'hook' || g.kind === 'contract-test') && 'preCommit' in g) {
      errors.push(
        `Guard "${g.id}" (kind "${g.kind}") carries a preCommit flag — only gates run as derived ` +
          `pre-commit legs.`,
      );
    }
  }

  // ── union coverage + dead patterns ─────────────────────────────────────────
  const patterns = reach.flatMap((row) =>
    row.files.map((pattern) => ({ pattern: norm(pattern), row, matcher: matcherFor(norm(pattern)) })),
  );
  const unclaimed = files.filter((f) => !patterns.some((p) => matches(p.pattern, p.matcher, f)));
  if (unclaimed.length) {
    errors.push(
      `Tracked file(s) no reach row claims — every file is either scanned by a declared guard or a ` +
        `DECLARED gap, never silently unguarded:\n` +
        unclaimed.map((f) => `  - ${f}`).join('\n') +
        `\n  → add the file to an existing row in ${DATA_FILE}, or add a row (guardedBy a real guard ` +
        `id, or 'declared-gap' with the reason in note).`,
    );
  }
  const dead = patterns.filter((p) => !files.some((f) => matches(p.pattern, p.matcher, f)));
  if (dead.length) {
    errors.push(
      `Reach pattern(s) matching zero tracked files — a dead claim reads as coverage:\n` +
        dead.map((p) => `  - ${p.pattern} (${p.row.area})`).join('\n') +
        `\n  → drop or fix the pattern in ${DATA_FILE}.`,
    );
  }

  // ── wiring: every guard is enforced somewhere ──────────────────────────────
  const reachable = reachableScripts(packageScripts);
  const reachableCmds = [...reachable].map((name) => norm(packageScripts[name]));
  for (const g of guards) {
    const impl = norm(g.impl);
    if (g.kind === 'gate') {
      const wired = impl.includes('/')
        ? reachableCmds.some((cmd) => cmd.includes(impl))
        : reachable.has(impl);
      if (!wired) {
        errors.push(
          `Gate guard "${g.id}" is not reachable from verify:release — a script in no gate is not a ` +
            `gate. impl: ${g.impl}\n  → wire it into the verify chain (package.json) or remove the row.`,
        );
      }
    } else if (g.kind === 'hook') {
      if (!hookCommands.some((cmd) => cmd.includes(impl))) {
        errors.push(
          `Hook guard "${g.id}" is not registered in .claude/settings.json — an unregistered hook ` +
            `never fires. impl: ${g.impl}`,
        );
      }
      if (!files.includes(impl)) {
        errors.push(`Hook guard "${g.id}" impl is not a tracked file: ${g.impl}`);
      }
    } else if (g.kind === 'contract-test') {
      if (!files.includes(impl)) {
        errors.push(`Contract-test guard "${g.id}" impl is not a tracked file: ${g.impl}`);
      } else if (!impl.startsWith('tests/')) {
        errors.push(
          `Contract-test guard "${g.id}" lives outside tests/ — vitest excludes .claude/** and ` +
            `never runs it there. impl: ${g.impl}`,
        );
      }
    } else {
      errors.push(`Guard "${g.id}" has unknown kind "${g.kind}" — expected gate|hook|contract-test.`);
    }
  }

  // ── bidirectional: a new guard cannot land outside the registry ────────────
  const hookImpls = new Set(guards.filter((g) => g.kind === 'hook').map((g) => norm(g.impl)));
  const referencedHooks = new Set(
    hookCommands.flatMap((cmd) => [...cmd.matchAll(/\.claude\/hooks\/[A-Za-z0-9._-]+/g)].map((m) => m[0])),
  );
  for (const hook of referencedHooks) {
    if (!files.includes(hook)) {
      errors.push(`settings.json registers a hook that is not a tracked file: ${hook}`);
    }
    if (!hookImpls.has(hook)) {
      errors.push(
        `settings.json registers a hook with no GUARDS row: ${hook}\n  → add the row to ${DATA_FILE} ` +
          `(kind "hook", with its reach or uncovered half stated).`,
      );
    }
  }
  const gateCmds = guards
    .filter((g) => g.kind === 'gate')
    .map((g) => (norm(g.impl).includes('/') ? norm(g.impl) : norm(packageScripts[g.impl] ?? '')));
  for (const f of files) {
    if (/^scripts\/check-[^/]+\.mjs$/.test(f) && !gateCmds.some((cmd) => cmd.includes(f))) {
      errors.push(
        `Tracked check script no registered gate runs: ${f}\n  → a check script outside the registry ` +
          `is the smoke:linked drift shape. Register it in ${DATA_FILE} and wire it into the verify chain.`,
      );
    }
  }
  const gateIds = new Set(guards.filter((g) => g.kind === 'gate').flatMap((g) => [g.id, g.impl]));
  for (const name of Object.keys(packageScripts)) {
    if (name.startsWith('check:') && !gateIds.has(name)) {
      errors.push(
        `npm script "${name}" has no GUARDS row in ${DATA_FILE} — a check that exists only in ` +
          `package.json has undeclared reach.`,
      );
    }
  }

  return errors;
}

function collectHookCommands(settings) {
  const commands = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (typeof node.command === 'string') commands.push(node.command);
      return Object.values(node).forEach(walk);
    }
  };
  walk(settings.hooks ?? {});
  return commands;
}

function main() {
  const onDisk = execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
    cwd: repoRoot,
    windowsHide: true, // INV-WH — a console child from a windowless parent pops a window
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const packageScripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts;
  const settings = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8'));

  const errors = reconcile({
    guards: GUARDS,
    reach: REACH,
    onDisk,
    packageScripts,
    settingsHookCommands: collectHookCommands(settings),
  });

  if (errors.length) {
    console.error('✗ guard-reach check failed:\n\n' + errors.join('\n\n') + '\n');
    process.exit(1);
  }
  console.log(
    `✓ guard-reach: ${onDisk.length} tracked files all claimed across ${REACH.length} reach rows; ` +
      `${GUARDS.length} guards wired (gates reachable from verify:release, hooks registered, ` +
      `contract tests tracked)`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
