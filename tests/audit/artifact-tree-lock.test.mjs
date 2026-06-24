import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { artifactTreeLockPath, withFileLock } = await import("audit-tools/shared");

test("artifactTreeLockPath is under the artifacts dir, single-sourced", () => {
  const p = artifactTreeLockPath("/x/.audit-tools/audit");
  assert.equal(p, join("/x/.audit-tools/audit", "artifact-tree.lock"));
});

test("artifact-tree lock serializes concurrent read-modify-write critical sections", async () => {
  const artifactsDir = await mkdtemp(join(tmpdir(), "artifact-tree-lock-"));
  const lockPath = artifactTreeLockPath(artifactsDir);

  let active = 0;
  let maxConcurrent = 0;
  const order = [];

  async function criticalSection(id) {
    return withFileLock(lockPath, async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      // Simulate load → advance → persist taking some time.
      await new Promise((r) => setTimeout(r, 15));
      order.push(id);
      active -= 1;
    });
  }

  await Promise.all([
    criticalSection("a"),
    criticalSection("b"),
    criticalSection("c"),
  ]);

  assert.equal(maxConcurrent, 1, "no two critical sections ever overlap");
  assert.equal(order.length, 3, "all three committed");
});
