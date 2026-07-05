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

type StaticsTable = Record<string, ModelStatics>;

// Path to the vendored snapshot, resolved relative to the compiled module. At
// runtime this module lives at dist/shared/quota/modelStatics.js and the asset
// is copied to dist/shared/data/ by the build (see scripts/shared/copy-data-assets.mjs).
const SNAPSHOT_URL = new URL("../data/model-statics.generated.json", import.meta.url);

// Lazily loaded once, then cached. `null` means "load attempted and failed" so
// we degrade to empty without re-reading a missing/broken file on every lookup.
let cache: StaticsTable | null | undefined;

function loadTable(): StaticsTable | null {
  if (cache !== undefined) return cache;
  try {
    const raw = readFileSync(fileURLToPath(SNAPSHOT_URL), "utf-8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? (parsed as StaticsTable) : null;
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
 * Look up the vendored static metadata for a model id. Tries an exact match
 * first, then case-insensitive, then — for route-prefixed ids like
 * `<vendor>/<id>` or `<router>:<vendor>/<id>` — the segment after the last `/`
 * or `:` route separator. Model ids legitimately contain dots (e.g. a minor
 * version like `-4.1`), so dots are NEVER treated as a namespace separator.
 * Returns `undefined` for an unknown id or an unavailable dataset.
 */
export function resolveModelStatics(modelId: string | null | undefined): ModelStatics | undefined {
  if (!modelId || typeof modelId !== "string") return undefined;
  const table = loadTable();
  if (!table) return undefined;

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
