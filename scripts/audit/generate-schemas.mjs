// A6 — regenerate the worker-facing JSON schemas from their zod sources.
//
//   node --import tsx/esm scripts/audit/generate-schemas.mjs
//
// The committed schemas under `schemas/` are GENERATED artifacts; edit the zod
// sources in src/audit/contracts/workerSchemas.ts (or the base contracts they
// derive from) and rerun this. tests/audit/worker-schema-generation.test.ts
// fails if the committed files ever drift from what this script would write.

// sites-pinned: tests/audit/worker-schema-generation.test.ts, tests/shared/script-argv-refusal.test.ts
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardArgv } from "../shared/argvGuard.mjs";
import {
  WORKER_SCHEMA_SOURCES,
  renderWorkerJsonSchema,
} from "../../src/audit/contracts/workerSchemas.ts";

const args = guardArgv(process.argv.slice(2), {
  name: "generate-schemas",
  usage: "node --import tsx/esm scripts/audit/generate-schemas.mjs [--output-dir <existing-directory>]",
  values: ["--output-dir"],
});
const schemasDir = args.get("--output-dir") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

// Always write the full registry. The alternate destination is for verifying
// the real writer in isolation and does not select a partial output set.

for (const filename of Object.keys(WORKER_SCHEMA_SOURCES)) {
  const json = renderWorkerJsonSchema(filename);
  await writeFile(
    join(schemasDir, filename),
    JSON.stringify(json, null, 2) + "\n",
    "utf8",
  );
  process.stdout.write(`wrote ${join(schemasDir, filename)}\n`);
}
