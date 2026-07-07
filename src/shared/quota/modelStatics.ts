// Static per-model metadata resolver, backed by the vendored models.dev snapshot.
//
// This is the "dataset-as-fallback" half of quota-metadata resolution: when the
// dispatch-time capability handshake did NOT report a real window (headless /
// non-reporting hosts), we consult a community dataset for the model's real
// context window and price instead of falling straight to the conservative
// flat default. Real discovered capability always outranks this (see
// resolveLimits in ./limits.ts).
//
// Invariant-safe: the dataset is a VENDORED JSON asset (never a TS literal),
// consumed with degrade-to-empty semantics — a missing file, malformed JSON, or
// unknown model id resolves to `undefined`, never throws. Refresh the snapshot
// with `npm run update-models` (scripts/shared/update-models.mjs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Static, routing-relevant metadata for one model. All fields optional. */
export interface ModelStatics {
  /** Real context window in tokens (models.dev `limit.context`). */
  context_tokens?: number;
  /** Real max output window in tokens (models.dev `limit.output`). */
  output_tokens?: number;
  /** Per-million-token USD price (models.dev `cost`). */
  price?: {
    input?: number;
    output?: number;
  };
}

// Reserved top-level key carrying the optional per-provider index. A model id can
// never collide with it: models.dev ids never begin with the double underscore.
const BY_PROVIDER_KEY = "__by_provider";

/**
 * On-disk snapshot shape. The DEFAULT half is a flat `{ model_id: statics }` map
 * at the top level (so a snapshot with no cross-provider collisions is byte- and
 * behaviour-identical to the pre-(provider,model) format). The OPTIONAL
 * `__by_provider` half indexes the same statics by `(provider, model)` so a
 * caller that knows the provider can pin the native price instead of the
 * cheapest-collision default. Absent `__by_provider` ⇒ single-provider snapshot,
 * provider-scoped lookups degrade to the default.
 */
type StaticsTable = Record<string, ModelStatics>;
interface LoadedSnapshot {
  /** model_id → statics (cheapest on a cross-provider collision). */
  default: StaticsTable;
  /** provider → model_id → statics (only present when a collision existed). */
  byProvider: Record<string, StaticsTable>;
}

// Path to the vendored snapshot, resolved relative to the compiled module. At
// runtime this module lives at dist/shared/quota/modelStatics.js and the asset
// is copied to dist/shared/data/ by the build (see scripts/shared/copy-data-assets.mjs).
const SNAPSHOT_URL = new URL("../data/model-statics.generated.json", import.meta.url);

// Lazily loaded once, then cached. `null` means "load attempted and failed" so
// we degrade to empty without re-reading a missing/broken file on every lookup.
let cache: LoadedSnapshot | null | undefined;

function loadTable(): LoadedSnapshot | null {
  if (cache !== undefined) return cache;
  try {
    const raw = readFileSync(fileURLToPath(SNAPSHOT_URL), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      cache = null;
    } else {
      // Split the reserved `__by_provider` index off the flat default map. Every
      // remaining top-level key is a model-id → statics default entry.
      const byProviderRaw = (parsed as Record<string, unknown>)[BY_PROVIDER_KEY];
      const byProvider: Record<string, StaticsTable> =
        byProviderRaw && typeof byProviderRaw === "object"
          ? (byProviderRaw as Record<string, StaticsTable>)
          : {};
      const defaultTable: StaticsTable = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key === BY_PROVIDER_KEY) continue;
        if (value && typeof value === "object") defaultTable[key] = value as ModelStatics;
      }
      cache = { default: defaultTable, byProvider };
    }
  } catch {
    cache = null;
  }
  return cache;
}

/** Reset the in-memory cache. Test-only hook; production loads once. */
export function resetModelStaticsCache(): void {
  cache = undefined;
}

/**
 * Look up a model id in one statics table. Tries an exact match first, then
 * case-insensitive, then — for route-prefixed ids like `<vendor>/<id>` or
 * `<router>:<vendor>/<id>` — the segment after the last `/` or `:` route
 * separator. Model ids legitimately contain dots (e.g. a minor version like
 * `-4.1`), so dots are NEVER treated as a namespace separator.
 */
function lookupInTable(table: StaticsTable, modelId: string): ModelStatics | undefined {
  if (Object.prototype.hasOwnProperty.call(table, modelId)) return table[modelId];

  const lower = modelId.toLowerCase();
  // Candidate ids to try case-insensitively: the whole lowercased id, and the
  // tail after the last route separator (slash/colon only — never a dot).
  const candidates = new Set<string>([lower]);
  const lastSlash = Math.max(lower.lastIndexOf("/"), lower.lastIndexOf(":"));
  if (lastSlash >= 0 && lastSlash < lower.length - 1) {
    candidates.add(lower.slice(lastSlash + 1));
  }
  for (const key of Object.keys(table)) {
    if (candidates.has(key.toLowerCase())) return table[key];
  }
  return undefined;
}

/**
 * Look up the vendored static metadata for a model id, optionally scoped to a
 * provider.
 *
 * With no `provider`, resolves the DEFAULT entry — on a cross-provider model-id
 * collision that is the cheapest/native price, not the arbitrary first-sorted
 * provider — so an operator who doesn't name a backend never over-prices a model.
 *
 * With a `provider`, prefers that provider's own statics from the per-provider
 * index; falls back to the default entry when the snapshot has no provider-scoped
 * record (single-provider snapshot, or a model only one provider carries), so
 * provider scoping never resolves to *less* than the model-only lookup.
 *
 * `model_id` stays opaque — no vendor/window is inferred from its text. Returns
 * `undefined` for an unknown id or an unavailable dataset.
 */
export function resolveModelStatics(
  modelId: string | null | undefined,
  provider?: string | null,
): ModelStatics | undefined {
  if (!modelId || typeof modelId !== "string") return undefined;
  const snapshot = loadTable();
  if (!snapshot) return undefined;

  if (provider && typeof provider === "string") {
    const providerTable = snapshot.byProvider[provider];
    if (providerTable) {
      const hit = lookupInTable(providerTable, modelId);
      if (hit !== undefined) return hit;
    }
  }
  return lookupInTable(snapshot.default, modelId);
}
