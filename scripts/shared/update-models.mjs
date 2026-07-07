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
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(
  __dirname,
  "../../src/shared/data/model-statics.generated.json",
);

// Reserved top-level key carrying the per-provider index (kept in sync with
// src/shared/quota/modelStatics.ts). Model ids never begin with this prefix.
const BY_PROVIDER_KEY = "__by_provider";

// Input:output blend weights — MUST match COST_BLEND_* in
// src/shared/dispatch/costRank.ts so the cheapest-collision pick agrees with the
// runtime routing blend.
const COST_BLEND_INPUT_WEIGHT = 0.75;
const COST_BLEND_OUTPUT_WEIGHT = 0.25;

/** Coerce a finite positive number, else undefined. */
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Blend a statics record's price into one $/Mtok scalar, or undefined. */
function blendedPrice(record) {
  const input = record.price?.input;
  const output = record.price?.output;
  const hasInput = typeof input === "number" && Number.isFinite(input);
  const hasOutput = typeof output === "number" && Number.isFinite(output);
  if (hasInput && hasOutput) {
    return input * COST_BLEND_INPUT_WEIGHT + output * COST_BLEND_OUTPUT_WEIGHT;
  }
  if (hasInput) return input;
  if (hasOutput) return output;
  return undefined;
}

/** Build one statics record from a models.dev model entry, or undefined. */
function toRecord(entry) {
  if (!entry || typeof entry !== "object") return undefined;
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
    return undefined;
  }
  const record = {};
  if (contextTokens !== undefined) record.context_tokens = contextTokens;
  if (outputTokens !== undefined) record.output_tokens = outputTokens;
  if (priceInput !== undefined || priceOutput !== undefined) {
    record.price = {};
    if (priceInput !== undefined) record.price.input = priceInput;
    if (priceOutput !== undefined) record.price.output = priceOutput;
  }
  return record;
}

/**
 * Flatten models.dev's `{ provider: { models: { id: entry } } }` shape into a
 * `(provider, model)`-keyed dataset:
 *   - `default`     — model_id → statics; on a cross-provider collision the
 *                     CHEAPEST blended price wins (ties → first sorted provider),
 *                     so an operator who names no backend never over-prices.
 *   - `byProvider`  — provider → model_id → statics, populated only for the
 *                     model ids that actually collided (single-provider models
 *                     resolve fine from `default` alone, so we don't bloat the
 *                     snapshot with a per-provider copy of every model).
 * Providers and models are visited in sorted order so the result is deterministic
 * and the emitted key order stable.
 */
function flatten(apiData) {
  const providerIds = Object.keys(apiData).sort();

  // First pass: collect every (provider, model) record.
  // perModel: model_id → [{ providerId, record }] in sorted-provider order.
  const perModel = new Map();
  for (const providerId of providerIds) {
    const models = apiData[providerId]?.models;
    if (!models || typeof models !== "object") continue;
    for (const modelId of Object.keys(models).sort()) {
      const record = toRecord(models[modelId]);
      if (!record) continue;
      if (!perModel.has(modelId)) perModel.set(modelId, []);
      perModel.get(modelId).push({ providerId, record });
    }
  }

  const statics = {};
  const byProvider = {};
  let collisions = 0;
  for (const modelId of [...perModel.keys()].sort()) {
    const entries = perModel.get(modelId);
    if (entries.length === 1) {
      // No collision — behaviour-identical to the model-only snapshot.
      statics[modelId] = entries[0].record;
      continue;
    }
    collisions += entries.length - 1;
    // Default = cheapest blended price; an unpriced record ranks after any
    // priced one so a known price is preferred. Stable on sorted-provider order.
    let best = entries[0];
    let bestPrice = blendedPrice(best.record);
    for (const cand of entries.slice(1)) {
      const price = blendedPrice(cand.record);
      const cheaper =
        (bestPrice === undefined && price !== undefined) ||
        (price !== undefined && bestPrice !== undefined && price < bestPrice);
      if (cheaper) {
        best = cand;
        bestPrice = price;
      }
    }
    statics[modelId] = best.record;
    // Index every provider's own record so a provider-scoped lookup pins native.
    for (const { providerId, record } of entries) {
      if (!byProvider[providerId]) byProvider[providerId] = {};
      byProvider[providerId][modelId] = record;
    }
  }
  return { statics, byProvider, collisions };
}

/** Sort an object's keys so serialization is byte-stable across refreshes. */
function sortKeys(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return sorted;
}

/**
 * Emit the snapshot with sorted keys so the file is byte-stable across refreshes.
 * The `__by_provider` index is emitted (sorted by provider, then model) only when
 * a collision actually populated it, keeping a single-provider snapshot's file
 * byte-identical to the pre-(provider,model) format.
 */
function stableStringify({ statics, byProvider }) {
  const out = sortKeys(statics);
  const providerIds = Object.keys(byProvider);
  if (providerIds.length > 0) {
    const sortedByProvider = {};
    for (const providerId of providerIds.sort()) {
      sortedByProvider[providerId] = sortKeys(byProvider[providerId]);
    }
    out[BY_PROVIDER_KEY] = sortedByProvider;
  }
  return JSON.stringify(out, null, 2) + "\n";
}

async function main() {
  const t0 = Date.now();
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`models.dev fetch failed: ${res.status} ${res.statusText}`);
  }
  const apiData = await res.json();
  const { statics, byProvider, collisions } = flatten(apiData);
  const count = Object.keys(statics).length;
  if (count === 0) {
    throw new Error("models.dev flatten produced zero entries — refusing to write empty snapshot");
  }
  writeFileSync(OUT_FILE, stableStringify({ statics, byProvider }), "utf-8");
  const collidedModels = Object.keys(byProvider).length;
  console.log(
    `Updated ${path.relative(process.cwd(), OUT_FILE)}: ${count} models (${collisions} cross-provider collisions → cheapest default, ${collidedModels} providers indexed) in ${Date.now() - t0}ms`,
  );
}

// Exported for the pinning tests (flatten/collapse + serialization are the
// (provider, model) collision logic under test). `main()` still runs when the
// script is invoked directly (`npm run update-models`), but NOT when imported —
// otherwise the network fetch would fire at import time.
export { flatten, stableStringify, blendedPrice, BY_PROVIDER_KEY };

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
