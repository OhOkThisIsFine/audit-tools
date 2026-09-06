#!/usr/bin/env node
// P56 CANDIDATE — `npm run check:generated-artifacts`, the reconciliation leg.
//
// LANDING: `scripts/check-generated-artifacts.mjs`, wired as
// `"check:generated-artifacts": "node scripts/check-generated-artifacts.mjs"`
// and inserted into `verify:checks` immediately after `check:guard-reach`
// (it reconciles the same registry against the same tree, so it belongs
// beside it, and both are 'always'-triggered for the same reason: tree
// membership changes on any staged add / delete / rename).
//
// It reconciles the registry's GENERATED section against the TRACKED tree, in
// both directions. It never runs a generator and never writes anything — the
// individual `--check` legs and contract tests remain the things that detect
// staleness. This gate answers only the prior question the repo currently
// cannot answer at all: does every generated artifact HAVE a freshness
// authority, and does the authority each row names actually exist?
//
// Modeled on scripts/check-guard-reach.mjs, deliberately: that is the proven
// bidirectional shape in this repo, and a second shape would be the
// duplication the two-tier dependency policy and check:shared-primitives both
// exist to prevent.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// LANDING: `import { GENERATED } from './guard-reach-data.mjs';`
import { GENERATED } from './generated-artifacts-data.candidate.mjs';

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** Every tracked generator script: scripts/**\/generate-*.mjs plus the nightly renderer. */
function trackedGenerators() {
  const out = execFileSync('git', ['ls-files', '-z', 'scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((p) => /(^|\/)(generate-[^/]+|render-inbox)\.mjs$/.test(p))
    .sort();
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return new Set(out.split('\0').filter(Boolean));
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const scripts = pkg.scripts ?? {};
const verifyChecks = (scripts['verify:checks'] ?? '').split(/\s+/);

const failures = [];

// ---- direction 1: the tree → the registry ----
const claimed = new Map();
for (const row of GENERATED) {
  claimed.set(row.generator, (claimed.get(row.generator) ?? 0) + 1);
}
for (const generator of trackedGenerators()) {
  if (!claimed.has(generator)) {
    failures.push(
      `${generator}: tracked generator claimed by no GENERATED row. Add a row naming its ` +
        `freshness authority, or declare onDemand:true with a reason.`,
    );
  }
}
for (const [generator, n] of claimed) {
  if (n > 1) failures.push(`${generator}: claimed by ${n} rows — two answers about one authority`);
}

// ---- direction 2: the registry → the tree ----
const tracked = trackedFiles();
for (const row of GENERATED) {
  const { generator } = row;
  if (!tracked.has(generator)) {
    failures.push(`${generator}: row names a generator that is not a tracked file`);
    continue;
  }

  for (const artifact of row.artifacts ?? []) {
    if (!tracked.has(artifact)) {
      failures.push(`${generator}: declared artifact ${artifact} is not tracked`);
    }
  }

  if (row.onDemand === true) {
    if (row.authority !== undefined) {
      failures.push(`${generator}: onDemand row also claims authority '${row.authority}'`);
    }
    if (!(row.reason ?? '').trim()) {
      failures.push(
        `${generator}: onDemand with no stated reason. A gap is a decision; silence is a defect.`,
      );
    }
    continue;
  }

  if (row.authority === 'check') {
    const name = row.npmScript ?? '';
    const body = scripts[name];
    if (!body) {
      failures.push(`${generator}: authority 'check' names npm script '${name}', which does not exist`);
    } else {
      if (!body.includes('--check')) {
        failures.push(
          `${generator}: '${name}' does not pass --check, so it WRITES rather than verifies`,
        );
      }
      if (!verifyChecks.includes(name)) {
        failures.push(
          `${generator}: '${name}' is not inside verify:checks — a script in no gate is not a gate`,
        );
      }
    }
    continue;
  }

  if (row.authority === 'contractTest') {
    const path = row.contractTest ?? '';
    if (!path.startsWith('tests/')) {
      failures.push(
        `${generator}: contract test '${path}' is outside tests/ — vitest excludes .claude/**, ` +
          `so a test elsewhere never runs`,
      );
    } else if (!tracked.has(path) || !existsSync(join(ROOT, path))) {
      failures.push(`${generator}: contract test '${path}' is not a tracked file`);
    }
    continue;
  }

  failures.push(
    `${generator}: no authority — expected authority:'check', authority:'contractTest', or onDemand:true`,
  );
}

if (failures.length > 0) {
  console.error(`✗ check:generated-artifacts: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\nFix: add or correct the row in scripts/guard-reach-data.mjs (GENERATED section).\n`,
  );
  process.exit(1);
}

console.log(
  `✓ check:generated-artifacts: ${GENERATED.length} generator(s), each with an existing freshness authority`,
);
