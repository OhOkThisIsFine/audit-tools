// Refresh the vendored models.dev static-metadata snapshot.
//
// Fetches the community models.dev dataset and flattens it to a compact,
// model-id-keyed lookup of the STATIC half of quota metadata: per-model context
// window, output window, and per-million-token price. This is the
// "dataset-as-fallback" half of routing — dynamic capability discovery at the
// dispatch handshake always outranks it (see src/shared/quota/limits.ts).
//
// The snapshot is a VENDORED JSON asset, never inlined as a TS literal: the
// dataset is community-owned, degrade-to-empty on an unknown model id, and
// refreshed by re-running this script (`npm run update-models`). Keys are
// content-sorted so a refresh only churns the file when the upstream data
// actually changed.
//
// Usage: npm run update-models   (scripts/shared/update-models.mjs)

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(
  __dirname,
  "../../src/shared/data/model-statics.generated.json",
);

/** Coerce a finite positive number, else undefined. */
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Flatten models.dev's `{ provider: { models: { id: entry } } }` shape to a
 * flat `{ id: { context_tokens?, output_tokens?, price? } }` lookup. Providers
 * and models are visited in sorted order so a collision resolves deterministically
 * (first sorted provider wins) and the emitted key order is stable.
 */
function flatten(apiData) {
  const statics = {};
  let collisions = 0;
  const providerIds = Object.keys(apiData).sort();
  for (const providerId of providerIds) {
    const models = apiData[providerId]?.models;
    if (!models || typeof models !== "object") continue;
    for (const modelId of Object.keys(models).sort()) {
      const entry = models[modelId];
      if (!entry || typeof entry !== "object") continue;
      const contextTokens = positive(entry.limit?.context);
      const outputTokens = positive(entry.limit?.output);
      const priceInput = positive(entry.cost?.input);
      const priceOutput = positive(entry.cost?.output);
      // Skip models that carry none of the static metadata we route on.
      if (
        contextTokens === undefined &&
        outputTokens === undefined &&
        priceInput === undefined &&
        priceOutput === undefined
      ) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(statics, modelId)) {
        collisions++;
        continue; // first sorted provider wins — deterministic
      }
      const record = {};
      if (contextTokens !== undefined) record.context_tokens = contextTokens;
      if (outputTokens !== undefined) record.output_tokens = outputTokens;
      if (priceInput !== undefined || priceOutput !== undefined) {
        record.price = {};
        if (priceInput !== undefined) record.price.input = priceInput;
        if (priceOutput !== undefined) record.price.output = priceOutput;
      }
      statics[modelId] = record;
    }
  }
  return { statics, collisions };
}

/** Emit with sorted top-level keys so the file is byte-stable across refreshes. */
function stableStringify(statics) {
  const sorted = {};
  for (const id of Object.keys(statics).sort()) sorted[id] = statics[id];
  return JSON.stringify(sorted, null, 2) + "\n";
}

async function main() {
  const t0 = Date.now();
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status} ${res.statusText}`);
  }
  const apiData = await res.json();
  const { statics, collisions } = flatten(apiData);
  const count = Object.keys(statics).length;
  if (count === 0) {
    throw new Error("models.dev flatten produced zero entries — refusing to write empty snapshot");
  }
  writeFileSync(OUT_FILE, stableStringify(statics), "utf-8");
  console.log(
    `Updated ${path.relative(process.cwd(), OUT_FILE)}: ${count} models (${collisions} id collisions dropped) in ${Date.now() - t0}ms`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
