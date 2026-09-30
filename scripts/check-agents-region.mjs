#!/usr/bin/env node
// sites-pinned: tests/shared/agents-region-gate.test.ts
// AGENTS.md points at the live canonical instructions. It does not copy their
// contents, byte count or revision, so an ordinary CLAUDE.md edit needs no sync.
// This checks the active opening directive and its target, not instruction
// semantics, machine-global sync behavior or generated host command blocks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const CANONICAL_LINK = /^(?:>\s*)?(?:\*\*)?(?:Start with|Read)\s+\[[^\]\r\n]+\]\((?:\.\/)?CLAUDE\.md\)/u;

/** @param {{ agentsText: string, claudeText: string | undefined }} input */
export function validateAgentsRegion({ agentsText, claudeText }) {
  const opening = agentsText.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  if (!CANONICAL_LINK.test(opening)) {
    return {
      ok: false,
      reason: "AGENTS.md must open with a Read or Start with link to the repo-local CLAUDE.md; keep the canonical instructions in that file rather than copying them here.",
    };
  }
  if (claudeText === undefined || claudeText.trim().length === 0) {
    return { ok: false, reason: "AGENTS.md points to CLAUDE.md, but that canonical instruction file is missing or empty." };
  }
  return { ok: true };
}

function main() {
  let claudeText;
  try { claudeText = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8"); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
  }
  const verdict = validateAgentsRegion({
    agentsText: readFileSync(join(repoRoot, "AGENTS.md"), "utf8"),
    claudeText,
  });
  if (!verdict.ok) {
    process.stderr.write(`check:agents-region: ${verdict.reason}\n`);
    process.exit(1);
  }
  process.stdout.write("✓ agents-region: AGENTS.md points at the live canonical CLAUDE.md\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
