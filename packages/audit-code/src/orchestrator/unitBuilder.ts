import type { AuditUnit, Lens, RepoManifest, UnitManifest } from "../types.js";
import type { FileDisposition } from "@audit-tools/shared";
import {
  deriveBrowserExtensionLensesForPath,
  hasBrowserExtensionManifestFile,
  inferBrowserExtensionUnitKind,
} from "../extractors/browserExtension.js";
import { bucketFile, type FileBucket } from "../extractors/bucketing.js";
import { buildDispositionMap, isAuditExcludedStatus } from "../extractors/disposition.js";
import { pathTokens, normalizeExtractorPath } from "../extractors/pathPatterns.js";
import { LENS_ORDER, sortLenses } from "./auditTaskUtils.js";

const LENS_MAP: Record<FileBucket, Lens[]> = {
  runtime: ["correctness", "maintainability", "tests", "observability"],
  interface: ["correctness", "security", "reliability", "tests", "observability"],
  data_layer: ["correctness", "data_integrity", "reliability", "tests"],
  security_sensitive: ["security", "correctness", "reliability", "tests"],
  concurrency_state: ["reliability", "performance", "correctness", "tests", "observability"],
  tests: ["tests", "maintainability"],
  tooling_scripts: ["correctness", "operability", "config_deployment"],
  config_deployment: ["config_deployment", "reliability", "operability"],
  docs_specs: ["maintainability"],
  generated_vendor: ["maintainability"],
  unknown: ["correctness"],
};
const MAX_RISK_SCORE = 10;

function inferUnitKind(path: string, isBrowserExtensionProject = false): string {
  if (isBrowserExtensionProject) {
    const extensionKind = inferBrowserExtensionUnitKind(path);
    if (extensionKind) {
      return extensionKind;
    }
  }

  const normalized = path.toLowerCase();
  if (normalized.startsWith("apps/") || normalized.startsWith("services/"))
    return "service";
  if (normalized.startsWith("packages/")) return "package";
  if (normalized.startsWith("infra/")) return "infrastructure";
  if (normalized.startsWith("scripts/") || normalized.startsWith("bin/"))
    return "script";
  if (normalized.includes("test") || normalized.includes("spec")) return "test";
  if (
    normalized.includes("api/") ||
    normalized.includes("route") ||
    normalized.includes("controller")
  )
    return "interface";
  if (
    normalized.includes("model") ||
    normalized.includes("schema") ||
    normalized.includes("migration") ||
    normalized.includes("db/")
  )
    return "data";
  return "module";
}

function inferUnitId(path: string, kind: string): string {
  const parts = path.split("/");
  const normalized = path.toLowerCase();

  if ((parts[0] === "src" || parts[0] === "lib") && parts.length >= 3) {
    if (
      ["api", "routes", "controllers", "models", "db", "services"].includes(
        parts[1],
      )
    ) {
      return `${parts[0]}-${parts[1]}-${parts[2]}`.replace(
        /[^a-zA-Z0-9_-]/g,
        "-",
      );
    }
  }
  if ((parts[0] === "src" || parts[0] === "lib") && parts.length >= 2) {
    return `${parts[0]}-${parts[1]}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  if ((parts[0] === "tests" || parts[0] === "test") && parts.length >= 2) {
    return `tests-${parts[1]}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  if (parts.length >= 3) {
    return `${parts[0]}-${parts[1]}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  if (parts.length === 2) {
    return parts[0].replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  if (
    normalized.endsWith(".json") ||
    normalized.endsWith(".yaml") ||
    normalized.endsWith(".yml") ||
    normalized.endsWith(".toml") ||
    normalized.endsWith(".sh") ||
    normalized.includes("docker") ||
    normalized.startsWith(".")
  ) {
    return "root-config";
  }
  return `${kind}-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export { LENS_ORDER, sortLenses } from "./auditTaskUtils.js";

function applyExtensionLensGuards(path: string, lenses: Lens[]): Lens[] {
  const n = path.toLowerCase();
  if (n.endsWith(".schema.json") || n.endsWith(".schema.ts")) {
    return lenses.filter((l) => l === "data_integrity");
  }
  if (n.endsWith(".json") || n.endsWith(".yaml") || n.endsWith(".yml")) {
    return lenses.filter((l) => l !== "tests" && l !== "performance");
  }
  return lenses;
}

export function deriveRequiredLensesForPath(
  path: string,
  options: { isBrowserExtensionProject?: boolean } = {},
): Lens[] {
  const assignment = bucketFile(path);
  const required = new Set<Lens>();

  for (const bucket of assignment.buckets) {
    for (const lens of LENS_MAP[bucket]) {
      required.add(lens);
    }
  }

  if (options.isBrowserExtensionProject) {
    for (const lens of deriveBrowserExtensionLensesForPath(path)) {
      required.add(lens);
    }
  }

  return applyExtensionLensGuards(path, sortLenses(required));
}

function inferCriticalFlows(files: string[], requiredLenses: Lens[]): string[] {
  const flows = new Set<string>();
  const tokens = new Set(
    files.flatMap((f) => pathTokens(normalizeExtractorPath(f))),
  );
  if (tokens.has("auth") || tokens.has("session") || tokens.has("token")) {
    flows.add("auth-session");
  }
  if (tokens.has("billing") || tokens.has("invoice") || tokens.has("payment")) {
    flows.add("billing-payment");
  }
  if (
    tokens.has("queue") ||
    tokens.has("worker") ||
    tokens.has("job") ||
    requiredLenses.includes("reliability")
  ) {
    flows.add("async-processing");
  }
  if (
    tokens.has("deploy") ||
    tokens.has("docker") ||
    requiredLenses.includes("config_deployment")
  ) {
    flows.add("deployment-config");
  }
  return [...flows];
}

export function buildUnitManifest(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
): UnitManifest {
  const units = new Map<string, AuditUnit>();
  const isBrowserExtensionProject = hasBrowserExtensionManifestFile(repoManifest);
  const dispositionMap = buildDispositionMap(disposition);

  for (const file of repoManifest.files) {
    const status = dispositionMap.get(file.path);
    if (file.excluded || (status && isAuditExcludedStatus(status))) {
      continue;
    }

    const kind = inferUnitKind(file.path, isBrowserExtensionProject);
    const unitId = inferUnitId(file.path, kind);
    const existing = units.get(unitId) ?? {
      unit_id: unitId,
      name: unitId,
      kind,
      files: [],
      required_lenses: [],
    };

    if (!existing.files.includes(file.path)) {
      existing.files.push(file.path);
    }

    const assignment = bucketFile(file.path);
    const required = new Set<Lens>(existing.required_lenses);
    for (const lens of deriveRequiredLensesForPath(file.path, {
      isBrowserExtensionProject,
    })) {
      required.add(lens);
    }
    existing.required_lenses = sortLenses(required);

    const riskScore =
      new Set(assignment.buckets).size +
      (assignment.buckets.includes("security_sensitive") ? 3 : 0) +
      (assignment.buckets.includes("interface") ? 1 : 0) +
      (assignment.buckets.includes("data_layer") ? 1 : 0);
    existing.risk_score = Math.min(
      MAX_RISK_SCORE,
      Math.max(existing.risk_score ?? 0, riskScore),
    );
    existing.files = existing.files.sort((a, b) => a.localeCompare(b));
    existing.critical_flows = inferCriticalFlows(
      existing.files,
      existing.required_lenses,
    );

    units.set(unitId, existing);
  }

  return {
    units: [...units.values()].sort(
      (a, b) =>
        (b.risk_score ?? 0) - (a.risk_score ?? 0) ||
        a.unit_id.localeCompare(b.unit_id),
    ),
  };
}
