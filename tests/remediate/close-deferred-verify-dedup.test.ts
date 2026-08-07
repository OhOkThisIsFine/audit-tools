/**
 * cg-1 (2026-08-06 run, open-bugs): the close gate replayed deferred
 * dist-dependent verify commands VERBATIM per node — duplicate full
 * `tests/audit` passes, a 2h close drain. Three pins:
 *  - the sidecar actually PERSISTS `deferredVerifyCommands` (it was documented
 *    as recorded but never written, so nothing tool-side could drain it);
 *  - the close-side collector reads them across every run's sidecars;
 *  - the dedup collapses exact duplicates and subsumes what a green
 *    full-suite leg already covers, leaving only the true residual.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dedupeDeferredVerifyCommands,
  recordNodeAcceptOutcome,
  loadNodeAcceptOutcome,
} from "../../src/remediate/steps/dispatch.js";
import { collectDeferredVerifyCommands } from "../../src/remediate/phases/close.js";

const RM_DIRS: string[] = [];
afterEach(() => {
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("dedupeDeferredVerifyCommands", () => {
  it("collapses exact duplicates to one, first-seen order", () => {
    const { residual, subsumed } = dedupeDeferredVerifyCommands(
      ["npm run check", "npm run check", "node scripts/x.mjs", "npm run check"],
      { fullSuiteCovers: false },
    );
    expect(residual).toEqual(["npm run check", "node scripts/x.mjs"]);
    expect(subsumed).toEqual([]);
  });

  it("a green full-suite leg subsumes test-file vitest runs and whole-suite runs", () => {
    const { residual, subsumed } = dedupeDeferredVerifyCommands(
      [
        "npx vitest run tests/audit/a.test.ts",
        "npx vitest run tests/audit/a.test.ts tests/remediate/b.test.ts",
        "npx vitest run",
        "npm run check",
        "node scripts/remediate/verify-hosts.mjs",
      ],
      { fullSuiteCovers: true },
    );
    expect(subsumed).toEqual([
      "npx vitest run tests/audit/a.test.ts",
      "npx vitest run tests/audit/a.test.ts tests/remediate/b.test.ts",
      "npx vitest run",
    ]);
    expect(residual).toEqual(["npm run check", "node scripts/remediate/verify-hosts.mjs"]);
  });

  it("without full-suite coverage nothing is subsumed", () => {
    const { residual, subsumed } = dedupeDeferredVerifyCommands(
      ["npx vitest run tests/audit/a.test.ts"],
      { fullSuiteCovers: false },
    );
    expect(residual).toEqual(["npx vitest run tests/audit/a.test.ts"]);
    expect(subsumed).toEqual([]);
  });

  it("a vitest run naming a NON-test path is never subsumed", () => {
    const { residual } = dedupeDeferredVerifyCommands(
      ["npx vitest run tests/audit/a.test.ts --config configs/vitest.special.ts"],
      { fullSuiteCovers: true },
    );
    expect(residual).toHaveLength(1);
  });
});

describe("accept-outcome sidecar persistence of the deferral (cg-1 root cause)", () => {
  it("recordNodeAcceptOutcome persists deferredVerifyCommands + excludedFromCommit round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "accept-sidecar-"));
    RM_DIRS.push(dir);
    await recordNodeAcceptOutcome(
      dir,
      "RUN1",
      "CP-BLOCK-X",
      {
        outcome: "success",
        verifyPassed: true,
        merged: true,
        deferredVerifyCommands: ["npm run check", "npx vitest run tests/audit/a.test.ts"],
        excludedFromCommit: ["scratch.log"],
      },
      { root: dir },
    );
    const loaded = await loadNodeAcceptOutcome(dir, "RUN1", "CP-BLOCK-X");
    expect(loaded?.deferredVerifyCommands).toEqual([
      "npm run check",
      "npx vitest run tests/audit/a.test.ts",
    ]);
    expect(loaded?.excludedFromCommit).toEqual(["scratch.log"]);
  });
});

describe("collectDeferredVerifyCommands", () => {
  it("gathers deferred commands across every run's sidecars, skipping malformed records", () => {
    const dir = mkdtempSync(join(tmpdir(), "close-collect-"));
    RM_DIRS.push(dir);
    const implA = join(dir, "runs", "runA", "implement");
    const implB = join(dir, "runs", "runB", "implement");
    mkdirSync(implA, { recursive: true });
    mkdirSync(implB, { recursive: true });
    writeFileSync(
      join(implA, "accept-outcome-N1.json"),
      JSON.stringify({ deferred_verify_commands: ["npm run check"] }),
    );
    writeFileSync(
      join(implA, "accept-outcome-N2.json"),
      JSON.stringify({ merged: true }),
    );
    writeFileSync(join(implA, "accept-outcome-N3.json"), "{not json");
    writeFileSync(
      join(implB, "accept-outcome-N4.json"),
      JSON.stringify({ deferred_verify_commands: ["npm run check", "node scripts/x.mjs"] }),
    );
    const collected = collectDeferredVerifyCommands(dir);
    expect(collected).toEqual(["npm run check", "npm run check", "node scripts/x.mjs"]);
  });

  it("degrades to empty with no runs dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "close-collect-empty-"));
    RM_DIRS.push(dir);
    expect(collectDeferredVerifyCommands(dir)).toEqual([]);
  });
});
