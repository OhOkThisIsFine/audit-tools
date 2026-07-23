import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareImplementDispatch } from "../../src/remediate/steps/dispatch.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import type { Finding } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// A worker result file that is PRESENT but INVALID (malformed JSON or a result
// that fails the contract) must NOT be silently treated as "absent". A bare
// catch→undefined conflated the two: the merge loop's missing-file branch never
// fires (the file exists), so the corrupt result was neither surfaced nor
// re-dispatched. The fix archives the invalid file (to `.stale-*`) and
// re-dispatches a fresh prompt. These tests pin that behaviour — they fail
// against the old swallow-and-leave-it-in-place code (the original file would
// remain and no `.stale-*` archive would appear).
// ---------------------------------------------------------------------------

const RUN_ID = "run-invalid-result";
const BLOCK_ID = "TEST-BLOCK-INVALID";
const FINDING_ID = "F-INV-1";

function makeFinding(): Finding {
  return {
    id: FINDING_ID,
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability",
    summary: "Something to fix.",
    affected_files: [{ path: "src/remediate/phases/plan.ts" }],
    evidence: [],
  };
}

async function makeMinimalState(artifactsDir: string): Promise<void> {
  const finding = makeFinding();
  const state = {
    status: "implementing",
    plan: {
      // INV-RSM-STATE-COMPLETE: an implementing state persists plan identity.
      plan_id: "PLAN-INVALID-RESULT",
      findings: [finding],
      blocks: [
        {
          block_id: BLOCK_ID,
          items: [finding.id],
          deps: [],
        } as RemediationBlock,
      ],
    },
    items: {
      [finding.id]: {
        finding_id: finding.id,
        block_id: BLOCK_ID,
        status: "pending",
        item_spec: {
          finding_id: finding.id,
          concrete_change: "fix it",
          no_change: false,
          touched_files: ["src/remediate/phases/plan.ts"],
          tests_to_write: [],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  };
  await writeFile(join(artifactsDir, "state.json"), JSON.stringify(state, null, 2));
}

function implementRunDir(artifactsDir: string): string {
  return join(artifactsDir, "runs", RUN_ID, "implement");
}

function resultPath(artifactsDir: string): string {
  return join(implementRunDir(artifactsDir), `implement-${BLOCK_ID}.result.json`);
}

describe("present-but-invalid implement result is archived, not treated as absent", () => {
  let dir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "invalid-result-test-"));
    artifactsDir = join(dir, ".audit-tools", "remediation");
    await mkdir(implementRunDir(artifactsDir), { recursive: true });
    await makeMinimalState(artifactsDir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("archives a result file with malformed JSON and re-dispatches a fresh prompt", async () => {
    const rp = resultPath(artifactsDir);
    await writeFile(rp, "{ this is not valid json ");

    const plan = await prepareImplementDispatch({ root: dir, artifactsDir }, RUN_ID);

    // The corrupt file was moved out of the way (archived), not left in place.
    expect(existsSync(rp)).toBe(false);
    const archived = (await readdir(implementRunDir(artifactsDir))).filter((f) =>
      f.startsWith(`implement-${BLOCK_ID}.result.json.stale-`),
    );
    expect(archived.length).toBe(1);

    // The block was re-dispatched (a fresh prompt item is present), not silently
    // reconciled as complete.
    expect(plan.items.length).toBe(1);
    expect(plan.items[0].block_id).toBe(BLOCK_ID);
  });

  it("archives a result file that is valid JSON but fails the worker-result contract", async () => {
    const rp = resultPath(artifactsDir);
    // Well-formed JSON, but not a valid ImplementWorkerResult (wrong shape).
    await writeFile(rp, JSON.stringify({ not_a_result: true }));

    const plan = await prepareImplementDispatch({ root: dir, artifactsDir }, RUN_ID);

    expect(existsSync(rp)).toBe(false);
    const archived = (await readdir(implementRunDir(artifactsDir))).filter((f) =>
      f.startsWith(`implement-${BLOCK_ID}.result.json.stale-`),
    );
    expect(archived.length).toBe(1);
    expect(plan.items.length).toBe(1);
  });

  it("preserves the corrupt content in the archive (nothing is lost)", async () => {
    const rp = resultPath(artifactsDir);
    const corrupt = "{ broken: true, ";
    await writeFile(rp, corrupt);

    await prepareImplementDispatch({ root: dir, artifactsDir }, RUN_ID);

    const archived = (await readdir(implementRunDir(artifactsDir))).find((f) =>
      f.startsWith(`implement-${BLOCK_ID}.result.json.stale-`),
    );
    expect(archived).toBeDefined();
    const content = await readFile(join(implementRunDir(artifactsDir), archived!), "utf8");
    expect(content).toBe(corrupt);
  });
});
