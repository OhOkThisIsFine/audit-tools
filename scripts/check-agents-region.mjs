#!/usr/bin/env node
//
// check:agents-region — the freshness authority for the one generated region
// whose generator lives OUTSIDE this repository (P64, owner decision
// 2026-09-10).
//
// WHY THIS EXISTS. `~/.agent-config/sync.mjs` writes the region between the
// `shared:start` / `shared:end` markers in AGENTS.md. In POINTER mode (this
// repository's mode — CLAUDE.md is far past the generator's 12 KB inline
// budget) the region body depends on CLAUDE.md through exactly ONE value, the
// byte length it prints:
//
//     `CLAUDE.md` is the canonical instruction file for this repository. It is 38.5 KB,
//
// The generator computes it as `(Buffer.byteLength(sourceText,'utf8')/1024).toFixed(1)`
// and hashes the finished body into `shared-region-id`. So a CLAUDE.md edit
// changes the figure, the figure changes the body, the body changes the id, and
// the committed AGENTS.md disagrees with the tree until somebody REMEMBERS to
// re-run the generator.
//
// Nothing in this repository noticed. `check:generated-artifacts` reconciles
// TRACKED generators against declared freshness authorities, and this generator
// is not tracked — it lives on the machine, not in the repository — so the one
// generated file with no authority was the one that went stale. Three commits
// exist for no purpose but catching this region up after the fact (e4bfb97f,
// 1efa125f, 590b27b3), the divergence stood from a1616d1d (2026-09-07), and it
// cost two consecutive nightly runs their auto-apply capacity: a
// regenerated-but-uncommitted AGENTS.md is a DIRTY TREE, and the routine's
// clean-tree rule then holds every edit.
//
// THE CHECK IS EXACT, NOT A PROXY. In pointer mode the printed byte length is
// the only CLAUDE.md-derived input to the region, so a stated figure equal to
// the real size means the region is fresh and a figure that differs means it is
// stale. No dependency on the machine-wide generator: this runs in CI and in a
// fresh clone, where `~/.agent-config` does not exist — a gate that asks the
// local disk for its verdict is not a gate.
//
// SCOPE, stated outright: this covers the POINTER-mode size sentence and
// nothing else in the region. If the machine-wide fix (the other half of the
// P64 decision) retires that sentence, this check must be retired or rewritten
// in the same change — it would then find no sentence and fail closed with the
// message that says so, rather than passing vacuously.
//
//   node scripts/check-agents-region.mjs
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The generator's pointer sentence, whose captured group is the size it claims
 * CLAUDE.md has. An absent match means the region was hand-edited or the
 * generator switched this target to inline mode — both are refusals, never a
 * silent pass.
 */
export const POINTER_SENTENCE =
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
 * Reconcile the generated region against the real CLAUDE.md size.
 * @param {{ agentsText: string, claudeBytes: number }} input
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateAgentsRegion({ agentsText, claudeBytes }) {
  const stated = statedPointerKb(agentsText);
  if (stated === null) {
    return {
      ok: false,
      reason:
        "AGENTS.md carries no generated pointer sentence — either the region was hand-edited or " +
        "the generator switched this target to inline mode. Re-run `node ~/.agent-config/sync.mjs " +
        "--projects`; if the sentence is deliberately retired, retire or rewrite this check in the " +
        "same change.",
    };
  }
  const actual = actualPointerKb(claudeBytes);
  if (stated !== actual) {
    return {
      ok: false,
      reason:
        `AGENTS.md's generated region is stale: it states ${stated} KB, CLAUDE.md is ${actual} KB. ` +
        "Run `node ~/.agent-config/sync.mjs --projects` and stage AGENTS.md in the SAME commit as " +
        "the CLAUDE.md edit.",
    };
  }
  return { ok: true };
}

function main() {
  const verdict = validateAgentsRegion({
    agentsText: readFileSync(join(repoRoot, "AGENTS.md"), "utf8"),
    claudeBytes: statSync(join(repoRoot, "CLAUDE.md")).size,
  });
  if (!verdict.ok) {
    process.stderr.write(`check:agents-region: ${verdict.reason}\n`);
    process.exit(1);
  }
  process.stdout.write("✓ agents-region: AGENTS.md's generated region states CLAUDE.md's current size\n");
}

// Importable as a library (the contract test drives the validator directly);
// the CLI body runs ONLY on direct invocation.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();
