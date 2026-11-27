// sites-pinned: tests/audit-smoke.test.mjs
import {
  METADATA_SCHEMA_VERSION,
  type ArtifactMetadataManifest,
} from "../types/artifactMetadata.js";
/**
 * Metadata-migration fail-safe (CE-007). An on-disk manifest is recognized as
 * F1-current ONLY when it carries `metadata_schema_version >= METADATA_SCHEMA_VERSION`.
 * An absent/older tag (a pre-F1, whole-artifact-only manifest) is NOT recognized,
 * so its still-matching whole-artifact hashes must NEVER be trusted to skip a
 * changed element — every element is treated as stale (all re-derived). Pure
 * predicate; never throws.
 */
export function isMetadataManifestCurrent(
  manifest: ArtifactMetadataManifest | undefined,
): boolean {
  if (!manifest || typeof manifest !== 'object') return false;
  const version = (manifest as { metadata_schema_version?: unknown })
    .metadata_schema_version;
  return typeof version === 'number' && version >= METADATA_SCHEMA_VERSION;
}
