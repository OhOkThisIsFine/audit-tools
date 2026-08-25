/**
 * CP-NODE-7 (OBL-impl-block-5-inv-2, -fail-2) — the phase-1 auto-fix gate.
 *
 * Two obligations, one property: auto-fix must mutate NOTHING when the host
 * opts out or asks for a dry run, and the check must happen BEFORE the first
 * formatter is invoked. A dry run implemented as a post-hoc revert is
 * explicitly rejected — by the time a revert runs, the formatter has already
 * rewritten the tree, and a crash between the two leaves the mutation behind.
 *
 * "Mutated nothing" is therefore asserted at the SPAWN, not at the file
 * contents: the fixture plants a repo-local `prettier.cjs` whose only job is to
 * write a marker file. A marker on disk means a formatter ran, whatever it did
 * to the sources. That is what makes this a gate test rather than a
 * formatting test, and it is why the assertion survives on a machine with no
 * real prettier installed.
 *
 * Driven through `advanceAudit` — the same path a real `audit-code next-step`
 * takes — so a gate wired into the executor but not into the production
 * dispatch fails here (the CP-NODE-5 decline-veto defect was exactly that).
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileDispositionStatus } from "audit-tools/shared";
import { advanceAudit } from "../../src/audit/orchestrator/advance.js";
import { withTempDir } from "./helpers/withTempDir.mjs";
import { writeFixtureRepo } from "./helpers/fixture.mjs";

interface AutoFixesApplied {
  executed_tools: string[];
  failed_tools: string[];
  tool_timings: unknown[];
  timestamp: string;
}

const bundleWith = (paths: string[]) => ({
  file_disposition: {
    files: paths.map((path): { path: string; status: FileDispositionStatus } => ({
      path,
      status: "included",
    })),
  },
});

/**
 * A repo-local prettier whose ONLY effect is observable: it writes
 * `marker.txt`. `resolveNodeTool` prefers this arm (`node <path> --write …`),
 * so it runs in place of any real prettier on the machine.
 */
function plantMarkerFormatter(root: string): string {
  const markerPath = join(root, "prettier-ran-marker.txt");
  const binDir = join(root, "node_modules", "prettier", "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "prettier.cjs"),
    // Written from the script itself rather than passed in, so the marker
    // proves THIS spawn happened and not some ambient file.
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran\\n");\n`,
  );
  return markerPath;
}

async function prepareRepo(root: string): Promise<string> {
  await writeFixtureRepo(root);
  await writeFile(join(root, ".prettierrc.json"), "{}\n");
  return plantMarkerFormatter(root);
}

describe("phase-1 auto-fix opt-out and dry-run gate", () => {
  it("the ungated run DOES spawn the formatter (the control that keeps the gate tests honest)", async () => {
    await withTempDir("auto-fix-ungated-", async (root: string) => {
      const marker = await prepareRepo(root);

      const result = await advanceAudit(bundleWith(["src/api/auth.ts"]), {
        root,
        preferredExecutor: "auto_fix_executor",
      });

      expect(result.selected_executor).toBe("auto_fix_executor");
      expect(
        existsSync(marker),
        "without a gate the formatter must run — otherwise the gate assertions below prove nothing",
      ).toBe(true);
    });
  });

  it("opt-out: no formatter is spawned and nothing is written", async () => {
    await withTempDir("auto-fix-optout-", async (root: string) => {
      const marker = await prepareRepo(root);

      const result = await advanceAudit(bundleWith(["src/api/auth.ts"]), {
        root,
        preferredExecutor: "auto_fix_executor",
        autoFix: { enabled: false },
      });

      expect(
        existsSync(marker),
        "an opted-out auto-fix must never reach a formatter spawn",
      ).toBe(false);
      const applied = result.updated_bundle.auto_fixes_applied as AutoFixesApplied;
      expect(applied.executed_tools).toEqual([]);
      expect(applied.failed_tools, "a gate is not a formatter failure").toEqual([]);
    });
  });

  it("dry-run: no formatter is spawned — the gate precedes the mutation, never reverts it", async () => {
    await withTempDir("auto-fix-dryrun-", async (root: string) => {
      const marker = await prepareRepo(root);

      const result = await advanceAudit(bundleWith(["src/api/auth.ts"]), {
        root,
        preferredExecutor: "auto_fix_executor",
        autoFix: { dryRun: true },
      });

      expect(
        existsSync(marker),
        "a dry run must be a REFUSAL to spawn, not a spawn followed by a revert",
      ).toBe(false);
      const applied = result.updated_bundle.auto_fixes_applied as AutoFixesApplied;
      expect(applied.executed_tools).toEqual([]);
      expect(applied.failed_tools).toEqual([]);
    });
  });

  it("the gate names itself in the step summary, so a skipped phase is never silent", async () => {
    await withTempDir("auto-fix-summary-", async (root: string) => {
      await prepareRepo(root);

      const result = await advanceAudit(bundleWith(["src/api/auth.ts"]), {
        root,
        preferredExecutor: "auto_fix_executor",
        autoFix: { dryRun: true },
      });

      expect(result.progress_summary.toLowerCase()).toContain("dry run");
    });
  });
});
