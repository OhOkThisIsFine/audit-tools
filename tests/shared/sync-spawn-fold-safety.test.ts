// INV-SSF (sync-spawn fold safety): no synchronous child process reachable
// while an artifact-tree lock is held may run unbounded. The lock heartbeat is
// a `setInterval` (fileLock.ts), and a synchronous spawn blocks the event loop
// for its whole duration — so a long sync child starves the held lock's mtime
// beat until a second process classifies the LIVE lock stale and steals it
// (the incident `runTrackedAsync`'s own doc records). A per-spawn sync timeout
// is NOT a sufficient bound: two sequential sync spawns inside one synchronous
// function body give the loop no turn between them, so their durations SUM
// against the 30s stale window. The delivered property is therefore async
// migration for every fold-reachable spawn site, pinned here per module:
//
//   • src/shared/git.ts             — fold-reachable via intake/scope/structure
//   • src/audit/extractors/disposition.ts — fold-reachable via intake/structure
//   • src/shared/tooling/analyzerDeps.ts  — fold-reachable via graph enrichment
//
// The scan is textual on the SOURCE tree (the same idiom as the INV-WH raw
// spawn scanner): the forbidden tokens are the sync entry points. It cannot
// prove reachability — the module list is the reviewed reachability claim, and
// a new fold-reachable module must be added here when it appears.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");

const FOLD_REACHABLE_MODULES = [
  "src/shared/git.ts",
  "src/audit/extractors/disposition.ts",
  "src/shared/tooling/analyzerDeps.ts",
];

// Sync spawn entry points. `runTrackedAsync(` also contains `runTracked` as a
// substring, so the sync-twin token is matched with a negative lookahead.
const FORBIDDEN_TOKENS: { label: string; pattern: RegExp }[] = [
  { label: "spawnSync", pattern: /\bspawnSync\b/u },
  { label: "spawnSyncHidden", pattern: /\bspawnSyncHidden\b/u },
  { label: "runTracked (sync twin)", pattern: /\brunTracked(?!Async)\b/u },
  { label: "execSync", pattern: /\bexecSync\b/u },
];

for (const module of FOLD_REACHABLE_MODULES) {
  test(`INV-SSF: ${module} spawns children through the async exec twin only`, () => {
    const source = readFileSync(join(repoRoot, module), "utf8");
    const hits: string[] = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      // Comments may NAME the sync twin (e.g. "never runTracked"); only code
      // lines count. A leading `*` or `//` marks the documentation lines.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      for (const token of FORBIDDEN_TOKENS) {
        if (token.pattern.test(line)) {
          hits.push(`${module}:${index + 1} uses ${token.label}: ${trimmed}`);
        }
      }
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
}
