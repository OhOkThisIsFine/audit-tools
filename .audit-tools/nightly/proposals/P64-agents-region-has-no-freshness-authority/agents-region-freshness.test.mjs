// P64 red-green test — AGENTS.md's generated region must be fresh against CLAUDE.md.
//
// WHAT IS BROKEN. `AGENTS.md` carries a region written by the machine-wide
// generator `~/.agent-config/sync.mjs`. In POINTER mode that region's body
// depends on `CLAUDE.md` through exactly ONE value — the byte length it prints:
//
//     `CLAUDE.md` is the canonical instruction file for this repository. It is 38.3 KB,
//
// `buildBody` computes it as `(Buffer.byteLength(sourceText,'utf8')/1024).toFixed(1)`
// and `buildRegion` hashes the finished body into `shared-region-id`. So a
// CLAUDE.md edit changes the figure, the figure changes the body, and the body
// changes the id. The committed AGENTS.md then disagrees with the tree until
// somebody remembers to re-run the generator.
//
// Nothing in this repository notices. `check:generated-artifacts` reconciles
// TRACKED generators against declared freshness authorities, and this generator
// is not tracked here — it lives outside the repository — so the one generated
// file with no authority is the one that goes stale.
//
// THE CHECK IS EXACT, NOT A PROXY. In pointer mode the byte length is the only
// CLAUDE.md-derived input to the region, so a stated figure that matches the
// real size means the region is fresh, and a figure that does not match means it
// is stale. No dependency on the machine-wide generator: this runs in CI and in
// a fresh clone.
//
// THE SUBJECT IS THE COMMITTED TREE, read through `git show`, for two reasons.
// It is what CI checks out and what a release ships, and it does not depend on
// whatever an uncommitted working copy happens to hold — on the night this was
// written the working copy carried an uncommitted regeneration while the
// committed pair had been divergent since 2026-09-07.
//
// Run: node --test agents-region-freshness.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The committed bytes of one path, as CI would check it out. */
function committed(relPath) {
  return execFileSync("git", ["show", `HEAD:${relPath}`], {
    cwd: REPO,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** The candidate check, in the form the patch would ship as a script. */
export function statedPointerKb(agentsText) {
  const m = /is the canonical instruction file for this repository\. It is ([0-9]+\.[0-9]) KB,/.exec(
    agentsText,
  );
  return m ? m[1] : null;
}

export function actualPointerKb(bytes) {
  return (bytes / 1024).toFixed(1);
}

test("the AGENTS.md generated region states CLAUDE.md's current size", () => {
  const stated = statedPointerKb(committed("AGENTS.md").toString("utf8"));
  assert.notEqual(stated, null, "AGENTS.md must carry the generated pointer sentence");

  const actual = actualPointerKb(committed("CLAUDE.md").byteLength);
  assert.equal(
    stated,
    actual,
    `AGENTS.md's generated region is stale: it states ${stated} KB, CLAUDE.md is ${actual} KB. ` +
      "Regenerate with `node ~/.agent-config/sync.mjs --projects` and commit AGENTS.md " +
      "in the SAME commit as the CLAUDE.md edit.",
  );
});
