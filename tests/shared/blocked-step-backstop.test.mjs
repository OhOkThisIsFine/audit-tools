import { test, describe, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWithBlockedStepBackstop,
  writeBlockedStepContract,
  renderBlockedStepPrompt,
} from "audit-tools/shared";

describe("runWithBlockedStepBackstop", () => {
  test("passes the body's return value through and never calls the writer on success", async () => {
    let writes = 0;
    const result = await runWithBlockedStepBackstop(
      async () => "ok",
      async () => {
        writes += 1;
      },
    );
    expect(result).toBe("ok");
    expect(writes).toBe(0);
  });

  test("on a body throw, writes the blocked step with the message and rethrows the ORIGINAL error", async () => {
    const seen = [];
    const original = new Error("engine: exceeded maxTransitions (100)");
    await assert.rejects(
      () =>
        runWithBlockedStepBackstop(
          async () => {
            throw original;
          },
          async (reason) => {
            seen.push(reason);
          },
        ),
      (error) => error === original,
    );
    expect(seen).toEqual(["engine: exceeded maxTransitions (100)"]);
  });

  test("a failing blocked-step write never masks the original error", async () => {
    const original = new Error("the real failure");
    await assert.rejects(
      () =>
        runWithBlockedStepBackstop(
          async () => {
            throw original;
          },
          async () => {
            throw new Error("disk full");
          },
        ),
      (error) => error === original,
    );
  });

  test("stringifies non-Error throws into the reason", async () => {
    const seen = [];
    await assert.rejects(() =>
      runWithBlockedStepBackstop(
        async () => {
          throw "raw string failure";
        },
        async (reason) => {
          seen.push(reason);
        },
      ),
    );
    expect(seen).toEqual(["raw string failure"]);
  });
});

describe("writeBlockedStepContract", () => {
  test("writes a blocked current-step.json whose JSON names the cause on its own", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blocked-step-contract-"));
    try {
      const artifactsDir = join(dir, ".audit-tools", "audit");
      const step = await writeBlockedStepContract({
        tool: "audit-code",
        contractVersion: "audit-code-step/v1alpha1",
        artifactsDir,
        repoRoot: dir,
        runId: null,
        reason: "quota wall: pool exhausted",
      });
      expect(step.step_kind).toBe("blocked");
      expect(step.status).toBe("blocked");
      expect(step.allowed_commands).toEqual([]);

      const onDisk = JSON.parse(
        await readFile(join(artifactsDir, "steps", "current-step.json"), "utf8"),
      );
      expect(onDisk.step_kind).toBe("blocked");
      expect(onDisk.status).toBe("blocked");
      // The step JSON must say WHY on its own — a headless consumer sees only
      // this contract, never the prompt file.
      expect(onDisk.progress).toEqual({ summary: "quota wall: pool exhausted" });

      const prompt = await readFile(
        join(artifactsDir, "steps", "current-prompt.md"),
        "utf8",
      );
      expect(prompt).toBe(
        renderBlockedStepPrompt("audit-code", "quota wall: pool exhausted"),
      );
      expect(prompt).toContain("# audit-code blocked");
      expect(prompt).toContain("quota wall: pool exhausted");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
