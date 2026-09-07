#!/usr/bin/env node
// Reconcile the uppercase, nonnumeric INV-* namespaces used by production
// TypeScript against docs/glossary-ids.md. Numeric local invariants (`INV-12`)
// and lowercase test-family ids (`INV-remediate-state-01`) are deliberately
// outside the glossary's opaque production namespace.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_NAMESPACE = /\bINV-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*/g;
const GLOSSARY_ROW = /^\|\s*(INV-[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*)\s*\|/gm;

/** Extract named namespaces, dropping only trailing all-numeric instance parts. */
export function sourceInvariantNamespaces(sources) {
  const found = new Set();
  for (const source of sources) {
    for (const match of String(source).matchAll(SOURCE_NAMESPACE)) found.add(match[0]);
  }
  return found;
}

/** Extract the first-column ids from the glossary's concrete namespace table. */
export function glossaryInvariantNamespaces(markdown) {
  const found = new Set();
  for (const match of String(markdown).matchAll(GLOSSARY_ROW)) {
    if (match[1] !== 'INV-AREA-N') found.add(match[1]);
  }
  return found;
}

function sourceFiles(root) {
  return execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts'));
}

export function uncoveredInvariantNamespaces(root) {
  const sources = sourceFiles(root).map((path) => readFileSync(join(root, path), 'utf8'));
  const used = sourceInvariantNamespaces(sources);
  const documented = glossaryInvariantNamespaces(
    readFileSync(join(root, 'docs', 'glossary-ids.md'), 'utf8'),
  );
  return [...used].filter((namespace) => !documented.has(namespace)).sort();
}

function main() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const missing = uncoveredInvariantNamespaces(root);
  if (missing.length > 0) {
    process.stderr.write(
      `check-invariant-glossary: ${missing.length} production invariant namespace(s) have no glossary row:\n` +
        missing.map((id) => `  - ${id}`).join('\n') +
        `\n\nAdd each namespace to docs/glossary-ids.md with its contract and owning symbol/file.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`✓ invariant-glossary: every production INV-* namespace has a glossary row\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
