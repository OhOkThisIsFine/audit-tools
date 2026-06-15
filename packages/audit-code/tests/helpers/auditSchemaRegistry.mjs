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
  let files;
  try {
    files = (await readdir(schemasDir)).filter((f) =>
      f.endsWith(".schema.json"),
    );
  } catch (err) {
    throw new Error(
      `auditSchemaRegistry: failed to read schemas directory "${schemasDir}": ${err.message}`,
      { cause: err },
    );
  }
  const registry = {};
  for (const file of files) {
    try {
      registry[file] = JSON.parse(
        await readFile(join(schemasDir, file), "utf8"),
      );
    } catch (err) {
      throw new Error(
        `auditSchemaRegistry: failed to load schema file "${file}": ${err.message}`,
        { cause: err },
      );
    }
  }
  return registry;
}

let SCHEMA_REGISTRY;
try {
  SCHEMA_REGISTRY = await loadAllSchemas();
} catch (err) {
  // Re-throw with context so the importing test file sees a clear, diagnosable
  // message rather than an opaque module-load failure.
  throw new Error(
    `auditSchemaRegistry: schema registry initialisation failed — ${err.message}`,
    { cause: err },
  );
}
export { SCHEMA_REGISTRY };

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
