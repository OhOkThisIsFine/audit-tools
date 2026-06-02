import { createHash } from "node:crypto";
import { ARTIFACT_DEPENDENCY_MAP } from "./dependencyMap.js";

export function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item ?? null)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

// Artifacts that stamp a wall-clock `generated_at` on every (re)build. The
// timestamp is provenance, not content: two rebuilds with identical data but
// different timestamps must hash equal, or the artifact's revision churns every
// rebuild and perpetually re-stales its downstreams (e.g. audit-report.md
// depends on design_assessment) — a finalization-oscillation hazard.
const GENERATED_AT_STRIPPED_ARTIFACTS = new Set([
  "repo_manifest.json",
  "tooling_manifest.json",
  "audit_plan_metrics.json",
  "design_assessment.json",
]);

export function normalizeForMetadataHash(
  artifactName: string,
  value: unknown,
): unknown {
  if (
    GENERATED_AT_STRIPPED_ARTIFACTS.has(artifactName) &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const record = value as Record<string, unknown>;
    const { generated_at: _generatedAt, ...rest } = record;
    return rest;
  }
  return value;
}

export function hashArtifactValue(
  artifactName: string,
  value: unknown,
): string {
  return createHash("sha256")
    .update(stableStringify(normalizeForMetadataHash(artifactName, value)))
    .digest("hex");
}

export function buildReverseDependencyMap(): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const [upstream, downstreamList] of Object.entries(
    ARTIFACT_DEPENDENCY_MAP,
  )) {
    reverse[upstream] ??= [];
    for (const downstream of downstreamList) {
      reverse[downstream] ??= [];
      reverse[downstream].push(upstream);
    }
  }
  return reverse;
}
