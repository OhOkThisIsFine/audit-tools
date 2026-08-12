/**
 * N-remediate-phases — retired per-item phase writer stays removed.
 *
 * Resolves accepted counterexample CE-P3-001 ("both implement.ts AND dispatch.ts
 * set last_successful_step / write verify-evidence" contradicted "the legacy
 * implement.ts path is REMOVED"). The adapter-backed merge writer has since
 * also been retired; this guard preserves the still-live half of the invariant:
 * phase modules must not reintroduce per-item implementation-state writes.
 *
 * Covers:
 *  - OBL-INV-RPS-05 / OBL-SEAM-RPS-02 (CE-015, atomic-replace): the legacy
 *    phases/implement.ts per-item state-writer path is REMOVED; no second
 *    state.json writer for implement results remains (verification_obligation:
 *    a test/grep confirms it).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "..", "src", "remediate");

// ---------------------------------------------------------------------------
// OBL-INV-RPS-05 / OBL-SEAM-RPS-02 — legacy implement.ts path removed.
// ---------------------------------------------------------------------------

describe("N-remediate-phases — single state.json writer (CE-P3-001 / OBL-INV-RPS-05)", () => {
  it("the legacy phases/implement.ts per-item state-writer module is gone", () => {
    // Atomic-replace verification_obligation: the removed mechanism must not
    // linger. Its presence would reintroduce the dual-write interleave surface
    // and the duplicated REMEDIATION_STEP constant + evidence-path logic.
    expect(existsSync(join(SRC_DIR, "phases", "implement.ts"))).toBe(false);
  });

  it("no module under phases/ advances per-item state (sets last_successful_step)", async () => {
    // The legacy implement.ts per-item state-writer set
    // `item.last_successful_step = REMEDIATION_STEP.*` after each step. With that
    // path removed, no phase module may reclaim per-item implementation-state
    // ownership.
    const { readdir } = await import("node:fs/promises");
    const phaseFiles = (await readdir(join(SRC_DIR, "phases"))).filter((f) =>
      f.endsWith(".ts"),
    );
    const offenders: string[] = [];
    for (const file of phaseFiles) {
      const content = await readFile(join(SRC_DIR, "phases", file), "utf8");
      if (/last_successful_step\s*=/.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

});
