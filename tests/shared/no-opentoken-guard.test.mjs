import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Global guard for the opentoken -> headroom migration. opentoken command-wrapping
// is removed: host-level headroom (proxy/MCP) handles token compression, and the
// orchestrator never wraps commands itself. This is a MIGRATION/regression guard
// (not a forever-invariant): its job was to force the removal to 100% (a partial
// removal was the original failure). Once you're confident opentoken won't return,
// it can be retired — the durable guarantee is the deleted plumbing (no opentoken
// option on RunTracked, no OpenTokenConfig type), which makes reintroduction a
// deliberate re-plumbing rather than an accident.
//
// A sweeping "remove X everywhere" requirement gets ONE global negative invariant
// owned at the top — it cannot be partially satisfied, unlike per-module positives.

const here = dirname(fileURLToPath(import.meta.url));
// tests/ -> shared/ -> packages/ -> repo root
const repoRoot = join(here, "..", "..");
const SRC_DIRS = [
  join(repoRoot, "packages", "shared", "src"),
  join(repoRoot, "packages", "audit-code", "src"),
  join(repoRoot, "packages", "remediate-code", "src"),
];
const CODE_EXT = /\.(?:ts|mts|cts|js|mjs|cjs)$/u;

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (CODE_EXT.test(name)) out.push(p);
  }
  return out;
}

test("no opentoken references remain anywhere in src", () => {
  const hits = [];
  for (const srcDir of SRC_DIRS) {
    for (const file of walk(srcDir)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        if (/opentoken/iu.test(line)) {
          hits.push(`${file.slice(repoRoot.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.equal(
    hits.length,
    0,
    `opentoken is removed (superseded by headroom) — no references may remain in src.\n` +
      hits.join("\n"),
  );
});
