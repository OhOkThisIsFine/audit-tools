import {
  isNodeModulesOrGit,
  isTestPath,
  isInterfacePath,
  isDataLayerPath,
  isSecuritySensitivePath,
  isConcurrencyPath,
  isScriptPath,
  isDeploymentConfigPath,
  isDocPath,
  isGeneratedPath,
  normalizeExtractorPath,
} from "./pathPatterns.js";

export type FileBucket =
  | "runtime"
  | "interface"
  | "data_layer"
  | "security_sensitive"
  | "concurrency_state"
  | "tests"
  | "tooling_scripts"
  | "config_deployment"
  | "docs_specs"
  | "generated_vendor"
  | "unknown";

export interface BucketAssignment {
  path: string;
  buckets: FileBucket[];
  rationale: string[];
}

function addBucket(
  buckets: Set<FileBucket>,
  rationale: string[],
  bucket: FileBucket,
  reason: string,
): void {
  if (!buckets.has(bucket)) {
    buckets.add(bucket);
    rationale.push(reason);
  }
}

/**
 * Buckets files using the shared extractor heuristics so intake stays
 * consistent across OS-specific path separators and mixed-case manifests.
 */
export function bucketFile(path: string): BucketAssignment {
  const normalized = normalizeExtractorPath(path);
  const buckets = new Set<FileBucket>();
  const rationale: string[] = [];

  if (isNodeModulesOrGit(normalized)) {
    addBucket(buckets, rationale, "generated_vendor", "node_modules or .git excluded by convention");
    return { path, buckets: [...buckets], rationale };
  }

  if (isTestPath(normalized)) {
    addBucket(buckets, rationale, "tests", "path suggests tests");
  }
  if (isInterfacePath(normalized)) {
    addBucket(buckets, rationale, "interface", "path suggests interface code");
  }
  if (isDataLayerPath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "data_layer",
      "path suggests data-layer code",
    );
  }
  if (isSecuritySensitivePath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "security_sensitive",
      "path suggests security-sensitive code",
    );
  }
  if (isConcurrencyPath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "concurrency_state",
      "path suggests concurrency or stateful behavior",
    );
  }
  if (isScriptPath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "tooling_scripts",
      "path suggests tooling or scripts",
    );
  }
  if (isDeploymentConfigPath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "config_deployment",
      "path suggests config or deployment artifact",
    );
  }
  if (isDocPath(normalized)) {
    addBucket(buckets, rationale, "docs_specs", "path suggests documentation");
  }
  if (isGeneratedPath(normalized)) {
    addBucket(
      buckets,
      rationale,
      "generated_vendor",
      "path suggests generated or vendored content",
    );
  }
  if (buckets.size === 0) {
    addBucket(buckets, rationale, "runtime", "default runtime classification");
  }

  return {
    path,
    buckets: [...buckets],
    rationale,
  };
}
