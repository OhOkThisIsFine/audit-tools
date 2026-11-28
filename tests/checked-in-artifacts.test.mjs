import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { WORKER_SCHEMA_SOURCES, renderWorkerJsonSchema } from "../dist/audit/contracts/workerSchemas.js";
import { extractFileLockExportSurface, renderSurfacePin } from "../scripts/shared/generate-filelock-export-surface.mjs";

const LF = (value) => value.replace(/\r\n/g, "\n");
test("shipped worker schemas match their canonical contract", async () => {
  for (const name of Object.keys(WORKER_SCHEMA_SOURCES)) {
    const tracked = await readFile(new URL("../schemas/" + name, import.meta.url), "utf8");
    assert.equal(LF(tracked), JSON.stringify(renderWorkerJsonSchema(name), null, 2) + "\n", name);
  }
});
test("checked-in workflow boundaries match their canonical interfaces", async () => {
  const tracked = await readFile(new URL("../scripts/shared/filelock-export-surface.generated.json", import.meta.url), "utf8");
  assert.equal(LF(tracked), renderSurfacePin(extractFileLockExportSurface()));
  const canonical = await import("../dist/shared/loopCorePaths.js");
  const generated = await import("../.claude/hooks/loop-core-patterns.mjs");
  assert.deepEqual(generated.LOOP_CORE_PATTERNS, canonical.LOOP_CORE_PATTERNS);
  for (const classifier of [canonical, generated]) {
    assert.equal(classifier.isLoopCorePath("src/remediate/steps/intakeResolver.ts"), true);
    assert.equal(classifier.isLoopCorePath("src/audit/cli/lineIndex.ts"), false);
  }
});
