#!/usr/bin/env node
// CANDIDATE PATCH (P64) — would land as scripts/check-agents-region.mjs.
// Nothing in this directory is wired; leg 3 lands nothing.
//
// The freshness authority for the one generated region whose generator lives
// OUTSIDE this repository. `~/.agent-config/sync.mjs` writes the region in
// AGENTS.md between the `shared:start` / `shared:end` markers. In POINTER mode
// (this repository's mode — CLAUDE.md is far past the 12 KB inline budget) the
// region body depends on CLAUDE.md through exactly one value, the byte length
// it prints. So the stated figure IS the freshness signal, and comparing it
// with the real size is exact rather than approximate.
//
// This check deliberately does NOT call the machine-wide generator. A fresh
// clone and a CI runner have no `~/.agent-config`, and a gate that asks the
// local disk for its verdict is not a gate.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const POINTER_SENTENCE =
  /is the canonical instruction file for this repository\. It is ([0-9]+\.[0-9]) KB,/;

/** The size the region claims CLAUDE.md has, or null when the sentence is absent. */
export function statedPointerKb(agentsText) {
  const match = POINTER_SENTENCE.exec(agentsText);
  return match ? match[1] : null;
}

/** The size the generator would print for a source of `bytes` bytes. */
export function actualPointerKb(bytes) {
  return (bytes / 1024).toFixed(1);
}

/**
 * @param {{ agentsText: string, claudeBytes: number }} input
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateAgentsRegion({ agentsText, claudeBytes }) {
  const stated = statedPointerKb(agentsText);
  if (stated === null) {
    return {
      ok: false,
      reason:
        'AGENTS.md carries no generated pointer sentence. Either the region was hand-edited or ' +
        'the generator switched this target to inline mode; re-run `node ~/.agent-config/sync.mjs --projects`.',
    };
  }
  const actual = actualPointerKb(claudeBytes);
  if (stated !== actual) {
    return {
      ok: false,
      reason:
        `AGENTS.md's generated region is stale: it states ${stated} KB, CLAUDE.md is ${actual} KB. ` +
        'Run `node ~/.agent-config/sync.mjs --projects` and stage AGENTS.md in the SAME commit ' +
        'as the CLAUDE.md edit.',
    };
  }
  return { ok: true };
}

function main() {
  const root = process.cwd();
  const verdict = validateAgentsRegion({
    agentsText: readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    claudeBytes: statSync(join(root, 'CLAUDE.md')).size,
  });
  if (!verdict.ok) {
    process.stderr.write(`check:agents-region: ${verdict.reason}\n`);
    process.exit(1);
  }
  process.stdout.write("✓ agents-region: AGENTS.md's generated region matches CLAUDE.md\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) main();
