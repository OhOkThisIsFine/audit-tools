// Run-dir artifact naming for a remediation node.
//
// Every per-node artifact in `runs/<run-id>/implement/` is named by interpolating
// `block_id` straight into a filename, in SEVEN places across four modules — and
// `block_id` is `z.string()` with no charset constraint anywhere, minted by
// `toBlockId(ensureNodeId(node.id, i))`, where `node.id` comes from an LLM envelope
// via an unchecked cast (`contractPipeline/idRegistry.ts:26`). So the id is
// model-authored and a planner naming nodes after files ("src/auth.ts") is the
// obvious thing for it to do.
//
// `writeJsonFile` -> `writeFileAtomic` calls `ensureParentDirectory` first, so a
// path-shaped id does NOT throw: it silently mkdir -p's a subtree under the run dir
// and drops the sidecar inside it. A `..` segment walks OUT of the run dir. Both are
// cross-platform; the win32 `:` case (NTFS alternate-data-stream separator) is a
// third face of the same defect and is what the audit-side twin already sanitizes
// against (`rollingAuditDispatch.ts:297-303`).
//
// The invariant: a node's run-dir artifacts are FLAT FILES INSIDE the run dir, for
// every block id the contract admits.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { mkdtempSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { makeProviderNodeDispatcher } from "../../src/remediate/steps/providerNodeDispatch.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import type { FreshSessionProvider, ProviderSlot } from "audit-tools/shared";
import type { RemediationBlock } from "../../src/remediate/state/types.js";

const SLOT: ProviderSlot = { providerName: "stub", hostModel: null, poolId: "p/0" };

function block(id: string): RemediationBlock {
  return { block_id: id, items: ["F1"], parallel_safe: true, dependencies: [], touched_files: [] };
}

function dummyResult(): string {
  return JSON.stringify({
    contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
    items: [{ finding_id: "F1", status: "resolved", summary: "s", files_changed: [] }],
  });
}

/** Dispatch one node with `blockId` and report what landed in the run dir. */
async function dispatchWithBlockId(blockId: string): Promise<{
  outcome: string;
  runDirEntries: { name: string; isDir: boolean }[];
  taskPath: string | null;
  artifactsDir: string;
}> {
  const artifactsDir = realpathSync(mkdtempSync(join(tmpdir(), "sidecar-name-art-")));
  const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "sidecar-name-wt-")));
  const promptPath = join(artifactsDir, "prompt.md");
  writeFileSync(promptPath, "# node prompt\n");
  const resultPath = join(artifactsDir, "node.result.json");

  let capturedTaskPath: string | null = null;
  const stub: FreshSessionProvider = {
    name: "stub",
    async launch(input) {
      capturedTaskPath = input.taskPath ?? null;
      await writeFile(input.resultPath, dummyResult(), "utf8");
      return { accepted: true };
    },
  };

  const dispatch = makeProviderNodeDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: "RID",
    sessionConfig: null,
    promptPathByBlock: new Map([[blockId, promptPath]]),
    createProvider: () => stub,
  });

  const res = await dispatch({ block: block(blockId), slot: SLOT, worktreeRoot, resultPath });

  return {
    outcome: res.outcome,
    runDirEntries: readdirSync(artifactsDir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    })),
    taskPath: capturedTaskPath,
    artifactsDir,
  };
}

// Characters no NTFS filename may contain. `:` is the one a block id realistically
// carries (audit packet ids embed it), and it is why the audit-side twin sanitizes.
const WIN32_ILLEGAL = /[<>:"|?*\\/]/;

describe("per-node run-dir artifacts are flat files inside the run dir", () => {
  it("a plain block id writes its sidecar directly in the run dir (control)", async () => {
    const { outcome, taskPath, artifactsDir } = await dispatchWithBlockId("CP-BLOCK-B1");
    expect(outcome).toBe("success");
    expect(taskPath).not.toBeNull();
    expect(dirname(resolve(taskPath!))).toBe(resolve(artifactsDir));
  });

  it("a path-shaped block id must not mkdir a subtree under the run dir", async () => {
    // A planner naming a node after the file it fixes. `ensureParentDirectory`
    // makes this silently create `<runDir>/CP-BLOCK-src/` and hide the sidecar one
    // level down rather than failing, so the flatness is what has to be asserted.
    const { outcome, taskPath, artifactsDir, runDirEntries } =
      await dispatchWithBlockId("CP-BLOCK-src/auth.ts");
    expect(outcome).toBe("success");
    expect(dirname(resolve(taskPath!))).toBe(resolve(artifactsDir));
    // ...and no directory got minted from the id. (`runs/` is legitimate — the
    // token-usage ledger writes there.)
    expect(
      runDirEntries.filter((e) => e.isDir && e.name !== "runs").map((e) => e.name),
    ).toEqual([]);
  });

  it("a block id carrying ':' yields a filename legal on win32", async () => {
    // The originally-reported face of the defect: NTFS reads ':' as an
    // alternate-data-stream separator, so the raw name throws on the write —
    // before any launch. Asserted on the STRING so it fails on every platform.
    const { taskPath } = await dispatchWithBlockId("CP-BLOCK-root-config:auth");
    expect(taskPath).not.toBeNull();
    expect(basename(taskPath!)).not.toMatch(WIN32_ILLEGAL);
  });
});
