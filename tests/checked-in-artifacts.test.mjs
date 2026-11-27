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
test("the checked-in file lock interface matches its public exports", async () => {
  const tracked = await readFile(new URL("../scripts/shared/filelock-export-surface.generated.json", import.meta.url), "utf8");
  assert.equal(LF(tracked), renderSurfacePin(extractFileLockExportSurface()));
});
