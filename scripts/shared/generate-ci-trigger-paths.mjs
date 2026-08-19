#!/usr/bin/env node
// Generate `.github/workflows/ci.yml`'s two `paths:` trigger blocks from the
// guard-reach registry (`scripts/guard-reach-data.mjs`).
//
// WHY THIS EXISTS (P26, owner decision 2026-08-18). ci.yml's own comment states
// the invariant — "a gate's trigger paths must cover every path the gate
// INSPECTS" — yet the list was hand-written twice (push + pull_request) and
// drifted: `.claude/**` was absent while check:guard-reach reconciled those
// files, so a hook-only push (`ce83638f`, 2026-08-08) ran NO CI and a
// registry-row violation could land green. The guard-reach REACH rows already
// declare exactly which tracked files the gates scan, so the trigger list is
// DERIVED from them: the union of every non-declared-gap row's `files` globs,
// plus the always-trigger base below. A new claimed tree can no longer land
// outside the CI trigger set, and a deliberately-unguarded tree (declared-gap)
// deliberately does not trigger CI.
//
//   node scripts/shared/generate-ci-trigger-paths.mjs           # write
//   node scripts/shared/generate-ci-trigger-paths.mjs --check   # verify only
//
// `--check` is wired as `npm run check:ci-trigger-paths` (verify:checks + the
// derived pre-commit leg), so a stale block fails the build rather than
// silently narrowing CI.
//
// Registry globs use check-doc-manifest.mjs's grammar (`*` within a segment,
// `**` across segments); GitHub's path-filter grammar reads the same strings
// with the same intent, so they are emitted verbatim. Both blocks are rendered
// from one source — never rely on YAML anchors for this (GitHub Actions
// support is too new to trust).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REACH } from '../guard-reach-data.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_RELPATH = '.github/workflows/ci.yml';

// Paths that must trigger CI even though they live ONLY in declared-gap rows:
// a workflow edit must run the workflows it edits, and a lockfile change must
// re-run `npm ci` — excluding either because "no local gate parses it" would
// regress the trigger list a pure union produces.
export const ALWAYS_TRIGGER = ['.github/workflows/**', 'package-lock.json'];

export const BEGIN_MARKER =
  '# BEGIN generated ci-trigger-paths — derived from scripts/guard-reach-data.mjs by scripts/shared/generate-ci-trigger-paths.mjs. DO NOT EDIT between markers.';
export const END_MARKER = '# END generated ci-trigger-paths';

/** The sorted trigger-path union: non-declared-gap REACH rows + the base. */
export function deriveTriggerPaths(reach = REACH) {
  const paths = new Set(ALWAYS_TRIGGER);
  for (const row of reach) {
    if (row.guardedBy === 'declared-gap') continue;
    for (const f of row.files) paths.add(f.replace(/\\/g, '/'));
  }
  return [...paths].sort();
}

// The rendered `paths:` body for one block, at `indent` (the marker line's own
// indentation). Ends with `indent` so the END marker lands correctly indented.
export function renderPathsBlock(paths, indent) {
  const item = indent + '  ';
  const lines = [
    `${indent}paths:`,
    `${item}# Derived: the union of every non-declared-gap REACH row's file globs in`,
    `${item}# scripts/guard-reach-data.mjs, plus the always-trigger base (workflow +`,
    `${item}# lockfile edits must run CI even though both live in declared-gap rows).`,
    `${item}# A gate's trigger paths must cover every path the gate INSPECTS.`,
    `${item}# verify:checks runs check:doc-manifest, which reconciles EVERY tracked`,
    `${item}# *.md in the repo, not just docs/ — without "**/*.md" a markdown-only`,
    `${item}# push outside docs/ plants a violation CI never runs, which then`,
    `${item}# detonates on the next unrelated src/ commit. Happened 2026-07-19.`,
    ...paths.map((p) => `${item}- ${JSON.stringify(p)}`),
  ];
  return lines.join('\n') + '\n' + indent;
}

/**
 * Replace every BEGIN/END block body in `source` with the rendered paths.
 * Returns { output, blocks } — the caller asserts the expected block count.
 */
export function replaceTriggerBlocks(source, paths) {
  let output = '';
  let idx = 0;
  let blocks = 0;
  for (;;) {
    const b = source.indexOf(BEGIN_MARKER, idx);
    if (b < 0) break;
    const bodyStart = source.indexOf('\n', b) + 1;
    const e = source.indexOf(END_MARKER, bodyStart);
    if (e < 0 || bodyStart === 0) {
      throw new Error(`unterminated ci-trigger-paths block in ${TARGET_RELPATH}`);
    }
    const lineStart = source.lastIndexOf('\n', b - 1) + 1;
    const indent = source.slice(lineStart, b);
    output += source.slice(idx, bodyStart) + renderPathsBlock(paths, indent);
    idx = e;
    blocks++;
  }
  output += source.slice(idx);
  return { output, blocks };
}

function main() {
  const target = join(repoRoot, ...TARGET_RELPATH.split('/'));
  let source = null;
  try {
    source = readFileSync(target, 'utf8');
  } catch {
    /* missing */
  }
  if (source === null) {
    process.stderr.write(`${TARGET_RELPATH} is missing — nothing to generate into.\n`);
    process.exit(1);
  }
  const { output, blocks } = replaceTriggerBlocks(source, deriveTriggerPaths());
  if (blocks !== 2) {
    process.stderr.write(
      `${TARGET_RELPATH} carries ${blocks} generated ci-trigger-paths block(s), expected 2 ` +
        `(push + pull_request). Add the BEGIN/END marker comments around both paths: lists.\n`,
    );
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    if (output !== source) {
      process.stderr.write(
        `\n${TARGET_RELPATH} trigger paths are STALE against the guard-reach registry.\n` +
          `CI would trigger on a DIFFERENT path set than the gates inspect, which silently ` +
          `narrows (or widens) which pushes run CI.\n` +
          `Fix: node scripts/shared/generate-ci-trigger-paths.mjs\n\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `✓ ci-trigger-paths: ${deriveTriggerPaths().length} derived paths rendered identically in both ci.yml blocks\n`,
    );
    return;
  }

  writeFileSync(target, output, 'utf8');
  process.stdout.write(`wrote ${TARGET_RELPATH} (${deriveTriggerPaths().length} trigger paths, ${blocks} blocks)\n`);
}

// Importable as a library (the contract test drives the derivation and marker
// replacement directly); the CLI body runs ONLY on direct invocation.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
