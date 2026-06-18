// A6 — regenerate the worker-facing JSON schemas from their zod sources.
//
//   node --import tsx/esm scripts/audit/generate-schemas.mjs
//
// The committed schemas under `schemas/` are GENERATED artifacts; edit the zod
// sources in src/audit/contracts/workerSchemas.ts (or the base contracts they
// derive from) and rerun this. tests/audit/worker-schema-generation.test.mjs
// fails if the committed files ever drift from what this script would write.

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORKER_SCHEMA_SOURCES,
  renderWorkerJsonSchema,
} from "../../src/audit/contracts/workerSchemas.ts";

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

for (const filename of Object.keys(WORKER_SCHEMA_SOURCES)) {
  const json = renderWorkerJsonSchema(filename);
  await writeFile(
    join(schemasDir, filename),
    JSON.stringify(json, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`wrote schemas/${filename}\n`);
}
