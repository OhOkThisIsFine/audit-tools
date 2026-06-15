/**
 * N-remediate-phases — single-writer + step-constant/evidence-path agreement.
 *
 * Resolves accepted counterexample CE-P3-001 ("both implement.ts AND dispatch.ts
 * set last_successful_step / write verify-evidence" contradicted "the legacy
 * implement.ts path is REMOVED"). The fix is removal: dispatch.ts's wave path is
 * the SINGLE state.json writer for implement results, so the constant and the
 * evidence-artifact path have exactly one owner.
 *
 * Covers:
 *  - OBL-INV-RPS-05 / OBL-SEAM-RPS-02 (CE-015, atomic-replace): the legacy
 *    phases/implement.ts per-item state-writer path is REMOVED; no second
 *    state.json writer for implement results remains (verification_obligation:
 *    a test/grep confirms it).
 *  - OBL-INV-RPS-06 / OBL-SEAM-RPS-01 (COR-9da52fab): the single remaining
 *    writer sets last_successful_step = REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION
 *    via the named constant (never a bare string literal).
 *  - OBL-INV-RPS-10 / OBL-SEAM-RPS-01: that writer writes the canonical
 *    result_<finding_id>_verify_code_against_documentation.json evidence artifact.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import { mergeImplementResults } from "../src/steps/dispatch.js";
import { REMEDIATION_STEP } from "../src/state/types.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../src/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "..", "src");

// ---------------------------------------------------------------------------
// OBL-INV-RPS-05 / OBL-SEAM-RPS-02 — legacy implement.ts path removed; the
// dispatch.ts wave path is the single state.json writer for implement results.
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
    // path removed, the dispatch.ts wave merge is the SOLE writer of
    // last_successful_step. Guard against a second per-item state-writer
    // reappearing in any phase module.
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

  it("dispatch.ts is the single writer of last_successful_step across src/", async () => {
    // Whole-tree assertion: exactly one assignment site exists, and it lives in
    // the dispatch wave path. Two assignment sites would resurrect the dual-write
    // surface CE-P3-001 flagged.
    const { readdir } = await import("node:fs/promises");
    async function walk(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full)));
        else if (entry.name.endsWith(".ts")) out.push(full);
      }
      return out;
    }
    const writerFiles: string[] = [];
    for (const file of await walk(SRC_DIR)) {
      const content = await readFile(file, "utf8");
      if (/last_successful_step\s*=/.test(content)) writerFiles.push(file);
    }
    expect(writerFiles).toHaveLength(1);
    expect(writerFiles[0].replace(/\\/g, "/")).toMatch(/steps\/dispatch\.ts$/);
  });
});

// ---------------------------------------------------------------------------
// OBL-INV-RPS-06 / -10 / OBL-SEAM-RPS-01 — the single writer uses the named
// REMEDIATION_STEP constant and the canonical evidence-artifact path.
// ---------------------------------------------------------------------------

describe("N-remediate-phases — step constant + evidence path agreement (OBL-INV-RPS-06/-10)", () => {
  const TEST_DIR = join(__dirname, ".test-rps-single-writer");
  const REPO_DIR = join(TEST_DIR, "repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");
  const RUN_ID = "PLAN-RPS";

  function makeImplementingState(): RemediationState {
    return {
      status: "implementing",
      plan: {
        plan_id: RUN_ID,
        findings: [
          {
            id: "F-RPS",
            title: "Single-writer finding",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "Fix it.",
            affected_files: [{ path: "src/a.ts" }],
            evidence: ["evidence"],
          },
        ],
        blocks: [{ block_id: "B-RPS", items: ["F-RPS"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-RPS": { finding_id: "F-RPS", status: "pending", block_id: "B-RPS" },
      },
      closing_plan: { action: "none" },
    } as RemediationState;
  }

  async function writePlanAndResult(itemResults: unknown[]): Promise<void> {
    const dir = join(ARTIFACTS_DIR, "runs", RUN_ID, "implement");
    await mkdir(dir, { recursive: true });
    const taskId = "implement-B-RPS";
    const resultPath = join(dir, `${taskId}.result.json`);
    const plan = {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: RUN_ID,
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [
        {
          task_id: taskId,
          block_id: "B-RPS",
          prompt_path: join(dir, `${taskId}.md`),
          result_path: resultPath,
          access: { read_paths: ["src/a.ts"], write_paths: ["src/a.ts", resultPath] },
        },
      ],
    };
    await writeFile(join(dir, "dispatch-plan.json"), JSON.stringify(plan), "utf8");
    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: itemResults,
      }),
      "utf8",
    );
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("the single writer references the REMEDIATION_STEP constant, not a bare string literal", async () => {
    // Source-level guard: the dispatch merge path must use the named constant so
    // it cannot drift from state/types.ts. A bare inline string with the same
    // text would silently break the seam if the constant ever changes.
    const dispatchSrc = await readFile(
      join(SRC_DIR, "steps", "dispatch.ts"),
      "utf8",
    );
    expect(dispatchSrc).toMatch(
      /last_successful_step\s*=\s*\n?\s*REMEDIATION_STEP\.VERIFY_AGAINST_DOCUMENTATION/,
    );
    // And it must NOT assign the raw literal text to last_successful_step.
    expect(dispatchSrc).not.toMatch(
      /last_successful_step\s*=\s*["']Verify Code Against Documentation["']/,
    );
  });

  it("merging a resolved result stamps the constant value and writes the canonical evidence path", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeImplementingState());
    await writePlanAndResult([
      { finding_id: "F-RPS", status: "resolved", evidence: ["ran the focused test"] },
    ]);

    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      RUN_ID,
    );

    expect(merged.items!["F-RPS"].status).toBe("resolved");
    expect(merged.items!["F-RPS"].last_successful_step).toBe(
      REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION,
    );

    // Canonical evidence artifact path (OBL-INV-RPS-10): the single writer owns
    // result_<finding_id>_verify_code_against_documentation.json.
    const evidencePath = join(
      ARTIFACTS_DIR,
      "result_F-RPS_verify_code_against_documentation.json",
    );
    expect(existsSync(evidencePath)).toBe(true);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    expect(evidence.finding_id).toBe("F-RPS");
    expect(evidence.passed).toBe(true);
  });
});
