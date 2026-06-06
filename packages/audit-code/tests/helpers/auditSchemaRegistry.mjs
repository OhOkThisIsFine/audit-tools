import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMatchesJsonSchema as assertMatchesJsonSchemaRaw } from "./jsonSchemaAssert.mjs";

// Published schemas cross-reference sibling files (e.g. the shared lens.schema.json
// enum and shared.schema.json, pulled in via {"$ref":"<name>.schema.json"}). The
// validator resolves external refs through a registry, so preload every schema
// file once here and inject it into all assertions. This keeps every schema test
// from re-declaring which sibling schemas a given document happens to reference.
const schemasDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "schemas",
);

async function loadAllSchemas() {
  const files = (await readdir(schemasDir)).filter((f) =>
    f.endsWith(".schema.json"),
  );
  const registry = {};
  for (const file of files) {
    registry[file] = JSON.parse(await readFile(join(schemasDir, file), "utf8"));
  }
  return registry;
}

export const SCHEMA_REGISTRY = await loadAllSchemas();

/**
 * assertMatchesJsonSchema with every published audit-code schema preloaded into
 * the $ref registry. Callers can still add or override entries through
 * options.schemaRegistry.
 */
export function assertMatchesJsonSchema(schema, value, rootName, options = {}) {
  return assertMatchesJsonSchemaRaw(schema, value, rootName, {
    ...options,
    schemaRegistry: { ...SCHEMA_REGISTRY, ...(options.schemaRegistry ?? {}) },
  });
}
