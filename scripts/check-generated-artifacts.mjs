#!/usr/bin/env node
// Reconcile every tracked generator with exactly one declared freshness
// authority. Individual check legs and contract tests compare bytes; this gate
// makes the SET of generators and authorities mechanically complete.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GENERATED } from './guard-reach-data.mjs';

const GENERATOR_DECLARATION = /^\s*\/\/\s*@generated-artifact\b/m;
const DEFAULT_WRITE_ARM = /process\.argv\.includes\(\s*['"]--write['"]\s*\)/;
const WRITES_FILE = /\bwriteFileSync\s*\(/;
const SHARED_GENERATOR_RUNNER = /\bimport\s*\{[^}]*\brunGeneratedArtifactCli\b[^}]*\}\s*from/;

/**
 * Discover scripts that declare or implement a generator capability. The
 * explicit marker covers renderers whose names are intentionally not
 * `generate-*`; the source capabilities cover shared-runner and default
 * check/`--write` implementations. The established generate-* naming
 * convention remains a declaration in its own right.
 *
 * @param {{ scriptFiles: string[], readScript: (path: string) => string }} input
 */
export function discoverGeneratorCapabilities({ scriptFiles, readScript }) {
  return scriptFiles
    .filter((path) => path.endsWith('.mjs'))
    .filter((path) => {
      const source = readScript(path);
      return (
        /(^|\/)generate-[^/]+\.mjs$/.test(path) ||
        GENERATOR_DECLARATION.test(source) ||
        SHARED_GENERATOR_RUNNER.test(source) ||
        (DEFAULT_WRITE_ARM.test(source) && WRITES_FILE.test(source))
      );
    })
    .sort();
}

/**
 * @param {{
 *   rows: any[], generators: string[], trackedFiles: Set<string>,
 *   packageScripts: Record<string,string>
 * }} input
 */
export function validateGeneratedRegistry({ rows, generators, trackedFiles, packageScripts }) {
  const failures = [];
  const claimed = new Map();
  for (const row of rows) {
    claimed.set(row.generator, (claimed.get(row.generator) ?? 0) + 1);
  }
  for (const generator of generators) {
    if (!claimed.has(generator)) {
      failures.push(`${generator}: tracked generator claimed by no GENERATED row`);
    }
  }
  for (const [generator, count] of claimed) {
    if (count > 1) failures.push(`${generator}: claimed by ${count} rows`);
  }

  const verifySteps = (packageScripts['verify:checks'] ?? '').split(/\s+/);
  for (const row of rows) {
    if (!trackedFiles.has(row.generator)) {
      failures.push(`${row.generator}: row names a generator that is not tracked`);
      continue;
    }
    for (const artifact of row.artifacts ?? []) {
      if (!trackedFiles.has(artifact)) {
        failures.push(`${row.generator}: declared artifact ${artifact} is not tracked`);
      }
    }
    if (row.onDemand === true) {
      if (row.authority !== undefined) {
        failures.push(`${row.generator}: onDemand row also claims authority '${row.authority}'`);
      }
      if (!(row.reason ?? '').trim()) {
        failures.push(`${row.generator}: onDemand with no stated reason`);
      }
      continue;
    }
    if (row.authority === 'check') {
      const script = row.npmScript ?? '';
      const command = packageScripts[script];
      if (!command) {
        failures.push(`${row.generator}: check authority '${script}' does not exist`);
      } else {
        const checkMode = row.checkMode ?? 'flag';
        if (checkMode !== 'flag' && checkMode !== 'default') {
          failures.push(`${row.generator}: '${script}' has invalid checkMode '${checkMode}'`);
        } else if (checkMode === 'flag' && !command.includes('--check')) {
          failures.push(`${row.generator}: '${script}' does not pass --check`);
        } else if (checkMode === 'default' && /(?:^|\s)--write(?:\s|$)/.test(command)) {
          failures.push(`${row.generator}: default-check authority '${script}' invokes --write`);
        }
        if (!verifySteps.includes(script)) {
          failures.push(`${row.generator}: '${script}' is not inside verify:checks`);
        }
      }
      continue;
    }
    if (row.authority === 'contractTest') {
      const test = row.contractTest ?? '';
      if (!test.startsWith('tests/')) {
        failures.push(`${row.generator}: contract test '${test}' is outside tests/`);
      } else if (!trackedFiles.has(test)) {
        failures.push(`${row.generator}: contract test '${test}' is not tracked`);
      }
      continue;
    }
    failures.push(`${row.generator}: no check, contractTest, or onDemand authority`);
  }
  return failures;
}

function tracked(root, scope) {
  return execFileSync('git', ['ls-files', '-z', ...(scope ? [scope] : [])], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter(Boolean);
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const trackedFiles = new Set(tracked(root));
  const generators = discoverGeneratorCapabilities({
    scriptFiles: tracked(root, 'scripts'),
    readScript: (path) => readFileSync(join(root, path), 'utf8'),
  });
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const failures = validateGeneratedRegistry({
    rows: GENERATED,
    generators,
    trackedFiles,
    packageScripts: pkg.scripts ?? {},
  });
  if (failures.length > 0) {
    process.stderr.write(
      `check:generated-artifacts: ${failures.length} problem(s):\n` +
        failures.map((failure) => `  - ${failure}`).join('\n') +
        `\n\nFix: update the GENERATED section in scripts/guard-reach-data.mjs.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `✓ generated-artifacts: ${GENERATED.length} generator(s), each with a declared freshness authority\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
