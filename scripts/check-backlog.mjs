#!/usr/bin/env node
// sites-pinned: tests/shared/backlog-consolidated.test.ts
// One corpus load and grammar, independent refusal policies. Standalone
// diagnostic/baseline CLIs retain their existing APIs; release/commit use this draw.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guardArgv } from './shared/argvGuard.mjs';
import { parseBacklogDocument, findEntryBoundaryDamage, renderEntryBoundaryDamage } from './shared/backlog-entry-grammar.mjs';
import { evaluateBacklog, normalizeBaseline, headText } from './check-backlog-budget.mjs';
import { findStatusMarkers } from './check-backlog-status-tokens.mjs';
import { findLineNumberCitations } from './check-backlog-line-numbers.mjs';
import { evaluateFrictionTags } from './check-backlog-friction-tags.mjs';

/** Read each Markdown source exactly once; IO errors must propagate. */
export function loadBacklogCorpus(root, readText = (path) => readFileSync(path, 'utf8')) {
  const directory = join(root, 'docs', 'backlog');
  return readdirSync(directory).filter((name) => name.endsWith('.md')).sort().map((file) => {
    const text = readText(join(directory, file));
    return { file, text, document: parseBacklogDocument(text) };
  });
}

/** Keep full-text status/citation policies separate from entry-based policies. */
export function evaluateBacklogCorpus(files, baseline, { writeTime = false } = {}) {
  const corpus = files.map((source) => ({ ...source, document: source.document ?? parseBacklogDocument(source.text) }));
  const diagnostics = [];
  if (!writeTime) {
    const budget = evaluateBacklog(corpus, baseline);
    for (const message of budget.violations) diagnostics.push({ check: 'budget/property', message });
    for (const source of corpus) {
      const document = source.document;
      const damaged = findEntryBoundaryDamage(source.text, document.lines);
      if (damaged.length) diagnostics.push({ check: 'entry-boundary', message: renderEntryBoundaryDamage(damaged, `docs/backlog/${source.file}`) });
      for (const hit of findStatusMarkers(source.text, document.lines)) diagnostics.push({
        check: 'status', message: `docs/backlog/${source.file}:${hit.line}:${hit.column} — ${hit.kind}\n      ${hit.snippet}`,
      });
    }
  }
  for (const source of corpus) {
    for (const hit of findLineNumberCitations(source.text, source.document.lines)) diagnostics.push({
      check: 'line-citation', message: `docs/backlog/${source.file}:${hit.line}:${hit.column} — ${hit.kind} \`${hit.span}\`\n      ${hit.source.trim().slice(0, 140)}`,
    });
  }
  const friction = evaluateFrictionTags(corpus);
  for (const message of friction.violations) diagnostics.push({ check: 'friction', message });
  return { diagnostics, files: files.length };
}

export function runBacklogCheck(root, { writeTime = false } = {}) {
  const files = loadBacklogCorpus(root);
  let baseline = normalizeBaseline(null);
  if (!writeTime) {
    const path = join(root, 'docs', 'backlog', '.size-baseline.json');
    try { baseline = normalizeBaseline(JSON.parse(readFileSync(path, 'utf8'))); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw new Error(`Cannot read backlog baseline ${path}`, { cause: error });
    }
  }
  const sources = writeTime ? files : files.map((source) => ({ ...source, previousText: headText(source.file, root) }));
  return evaluateBacklogCorpus(sources, baseline, { writeTime });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = guardArgv(process.argv.slice(2), {
    name: 'check-backlog', usage: 'node scripts/check-backlog.mjs [--root <path>] [--write-time]',
    values: ['--root'], flags: ['--write-time'],
  });
  const root = resolve(args.get('--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  try {
    const result = runBacklogCheck(root, { writeTime: args.has('--write-time') });
    if (args.has('--write-time')) console.log('[backlog:budget/property] deferred to commit; the baseline is unchanged');
    if (result.diagnostics.length) {
      console.error(result.diagnostics.map(({ check, message }) => `[backlog:${check}] ${message}`).join('\n\n'));
      process.exitCode = 1;
    } else console.log(`✓ backlog: ${result.files} file(s) satisfy ${args.has('--write-time') ? 'line and friction' : 'budget/property, entry-boundary, status, line and friction'} checks`);
  } catch (error) {
    console.error(`[backlog:source] ${/** @type {Error} */ (error).message}`);
    process.exitCode = 1;
  }
}
