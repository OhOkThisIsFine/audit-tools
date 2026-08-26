/**
 * Filesystem-safe artifact naming for a content id.
 *
 * Ids that name artifacts are model-authored or model-derived — audit packet ids
 * embed `:` ("root-config:correctness:packet-3"), and remediation block ids are
 * `toBlockId(ensureNodeId(node.id, i))` over a DAG parsed from an LLM envelope via
 * an unchecked cast. Neither carries a charset constraint, so interpolating one
 * straight into a filename is unsound in three distinct ways:
 *
 *   • `:` is an alternate-data-stream separator on NTFS, so the write THROWS on
 *     win32 — before any worker launches.
 *   • a `/` or `\` segment does NOT throw: `writeFileAtomic` runs
 *     `ensureParentDirectory` first, so it silently mkdir -p's a subtree and hides
 *     the artifact one level down, on every platform.
 *   • two ids differing only in stripped characters would otherwise collide.
 *
 * The digest suffix is what makes the mapping injective — sanitizing alone maps
 * "a:b" and "a/b" onto the same stem. Both halves are load-bearing.
 *
 * This lives in `shared` because BOTH orchestrators name artifacts from ids: audit
 * through the packet/task/prompt/result paths, remediate through the per-node run
 * dir. `isCanonicalResultFilename` sits here too, deliberately — it is the
 * RECOGNIZER for the exact string `artifactNameForId` produces, and keeping a
 * format and its recognizer in one module is what stops the pair drifting.
 */

import { hashContent } from "../hash.js";

/** First 12 hex chars of the id's sha256 — the injective half of the name. */
export function digestId(value: string): string {
  return hashContent(value, { length: 12 });
}

/**
 * The readable half: the id reduced to `[a-zA-Z0-9_-]`, capped at 80 chars so a
 * long id cannot push the full name past a path limit. Lossy by design — the
 * digest carries the identity.
 */
export function safeArtifactStem(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : "artifact";
}

/**
 * The canonical artifact filename for an id: `<stem>_<digest>.<extension>`.
 * `extension` may carry its own dotted segments ("inline-result.json",
 * "task.json"), which is what keeps a node's sidecars co-named with its result.
 */
export function artifactNameForId(value: string, extension: string): string {
  return `${safeArtifactStem(value)}_${digestId(value)}.${extension}`;
}

// Canonical result filenames produced by artifactNameForId: a stem, "_", a
// 12-hex sha256 digest, then ".json" — optionally with one extra suffix segment
// before ".json" (the host writes packet results as "<stem>_<digest>.inline-result.json").
const CANONICAL_RESULT_FILENAME = /_[0-9a-f]{12}(\.[a-z0-9-]+)?\.json$/i;

// True when `filename` matches the canonical result naming above. Lets result
// ingestion tell legitimate task / prior-round results apart from
// genuinely stray files (e.g. packet-23-results.json) left in task-results/.
export function isCanonicalResultFilename(filename: string): boolean {
  return CANONICAL_RESULT_FILENAME.test(filename);
}
