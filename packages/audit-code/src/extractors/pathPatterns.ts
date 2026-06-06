/**
 * Shared bootstrap heuristics for the extractor layer. These rules run before
 * richer graph/unit analysis exists, so they intentionally favor recall over
 * precision and always normalize case, path separators, and simple camelCase
 * boundaries first.
 */
export const EXTRACTOR_HEURISTIC_NOTE =
  "Heuristic path classification normalizes case, path separators, and simple camelCase boundaries, then matches conservative keyword groups; confirm unusual repo layouts manually.";

const BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".avif",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
] as const;

const LOCKFILE_NAMES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "composer.lock",
  "go.sum",
] as const;

const TEST_SEGMENTS = ["test", "tests", "spec", "specs", "__tests__"] as const;
const TEST_FILE_TOKENS = ["test", "spec"] as const;
const INTERFACE_KEYWORDS = [
  "route",
  "routes",
  "controller",
  "controllers",
  "handler",
  "handlers",
  "endpoint",
  "endpoints",
] as const;
const DATA_LAYER_KEYWORDS = [
  "model",
  "models",
  "schema",
  "schemas",
  "migration",
  "migrations",
  "seed",
  "seeds",
] as const;
const SECURITY_KEYWORDS = [
  "auth",
  "authentication",
  "authorization",
  "credential",
  "credentials",
  "jwt",
  "oauth",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
  "permission",
  "permissions",
  "session",
  "sessions",
] as const;
const CONCURRENCY_KEYWORDS = [
  "queue",
  "queues",
  "worker",
  "workers",
  "job",
  "jobs",
  "cache",
  "caches",
  "retry",
  "retries",
  "lock",
  "locks",
] as const;
const SCRIPT_KEYWORDS = ["script", "scripts"] as const;
const DEPLOYMENT_KEYWORDS = [
  "docker",
  "terraform",
  "deploy",
  "deployment",
  "deployments",
  "workflow",
  "workflows",
  "k8s",
] as const;
const SURFACE_KEYWORDS = [
  "route",
  "routes",
  "controller",
  "controllers",
  "handler",
  "handlers",
  "worker",
  "workers",
  "job",
  "jobs",
  "command",
  "commands",
] as const;
const BILLING_KEYWORDS = [
  "billing",
  "invoice",
  "invoices",
  "payment",
  "payments",
  "ledger",
  "ledgers",
  "subscription",
  "subscriptions",
] as const;
const IDENTITY_KEYWORDS = ["user", "users"] as const;
const ASYNC_TASK_KEYWORDS = ["task", "tasks"] as const;

export function normalizeExtractorPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function splitSegments(normalized: string): string[] {
  return normalized.split("/").filter(Boolean);
}

function hasSegment(normalized: string, segment: string): boolean {
  return splitSegments(normalized).includes(segment);
}

/**
 * True when any of `segments` appears as a path segment. Splits the path once
 * and tests all candidates against that single set, instead of re-splitting per
 * segment as repeated `hasSegment` calls would.
 */
function hasAnySegment(normalized: string, segments: readonly string[]): boolean {
  const present = new Set(splitSegments(normalized));
  return segments.some((segment) => present.has(segment));
}

function includesAny(normalized: string, values: readonly string[]): boolean {
  return values.some((value) => normalized.includes(value));
}

function endsWithAny(normalized: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}

function baseName(normalized: string): string {
  const segments = splitSegments(normalized);
  return segments.at(-1) ?? normalized;
}

export function pathTokens(normalized: string): string[] {
  return normalized.split(/[^a-z0-9]+/).filter(Boolean);
}

function hasToken(normalized: string, values: readonly string[]): boolean {
  const tokens = new Set(pathTokens(normalized));
  return values.some((value) => tokens.has(value));
}

export function isNodeModulesOrGit(normalized: string): boolean {
  return hasSegment(normalized, "node_modules") || hasSegment(normalized, ".git");
}

/**
 * `.tmp/` holds transient scratch and bundled tool copies (e.g. a vendored
 * `.tmp/opentoken`). These are not the audited project's source — excluding
 * them keeps the self-audit from auditing its own bundled dependencies.
 */
export function isTmpPath(normalized: string): boolean {
  return hasSegment(normalized, ".tmp");
}

export function isBuildOutput(normalized: string): boolean {
  return hasSegment(normalized, "dist") || hasSegment(normalized, "build");
}

export function isVendorPath(normalized: string): boolean {
  return (
    hasSegment(normalized, "vendor") ||
    hasSegment(normalized, "vendors") ||
    hasSegment(normalized, "third_party")
  );
}

export function isBinaryArtifact(normalized: string): boolean {
  return endsWithAny(normalized, BINARY_EXTENSIONS);
}

export function isLogPath(normalized: string): boolean {
  return normalized.endsWith(".log") || includesAny(normalized, ["stdout.log", "stderr.log"]);
}

export function isLicensePath(normalized: string): boolean {
  const base = baseName(normalized);
  return base === "license" || base.startsWith("license.");
}

export function isLockfilePath(normalized: string): boolean {
  return endsWithAny(normalized, LOCKFILE_NAMES);
}

export function isDocPath(normalized: string): boolean {
  return normalized.endsWith(".md") || hasSegment(normalized, "docs");
}

export function isGeneratedInstallArtifactPath(normalized: string): boolean {
  return normalized.startsWith(".audit-code/install/");
}

export function isGeneratedTestArtifactPath(normalized: string): boolean {
  return splitSegments(normalized).some(
    (segment) =>
      segment.startsWith(".test-") && segment.endsWith("-artifacts"),
  );
}

export function isAuditArtifactPath(normalized: string): boolean {
  return hasSegment(normalized, ".audit-artifacts");
}

export function isTestPath(normalized: string): boolean {
  const segments = splitSegments(normalized);
  if (segments.some((segment) => TEST_SEGMENTS.some((testSegment) => testSegment === segment))) {
    return true;
  }
  const fileTokens = pathTokens(baseName(normalized));
  return TEST_FILE_TOKENS.some((token) => fileTokens.includes(token));
}

export function isInterfacePath(normalized: string): boolean {
  return hasToken(normalized, INTERFACE_KEYWORDS) || hasSegment(normalized, "api");
}

const DATA_LAYER_SEGMENTS = [
  "models",
  "schemas",
  "migrations",
  "seeds",
  "db",
] as const;

export function isDataLayerPath(normalized: string): boolean {
  return (
    hasToken(normalized, DATA_LAYER_KEYWORDS) ||
    hasAnySegment(normalized, DATA_LAYER_SEGMENTS)
  );
}

export function isSecuritySensitivePath(normalized: string): boolean {
  return hasToken(normalized, SECURITY_KEYWORDS);
}

export function isConcurrencyPath(normalized: string): boolean {
  return hasToken(normalized, CONCURRENCY_KEYWORDS);
}

export function isExamplesOrFixturesPath(normalized: string): boolean {
  return hasSegment(normalized, "examples") || hasSegment(normalized, "fixtures");
}

export function isScriptPath(normalized: string): boolean {
  return (
    hasToken(normalized, SCRIPT_KEYWORDS) ||
    hasSegment(normalized, "scripts") ||
    hasSegment(normalized, "bin")
  );
}

export function isDeploymentConfigPath(normalized: string): boolean {
  return hasToken(normalized, DEPLOYMENT_KEYWORDS) || endsWithAny(normalized, [".yml", ".yaml"]);
}

export function isGeneratedPath(normalized: string): boolean {
  return (
    isVendorPath(normalized) ||
    normalized.endsWith(".map") ||
    normalized.endsWith(".wasm.mjs") ||
    normalized.endsWith(".wasm.js") ||
    hasToken(normalized, ["generated", "autogenerated"])
  );
}

export function isSurfacePath(normalized: string): boolean {
  return (
    hasSegment(normalized, "api") ||
    hasToken(normalized, SURFACE_KEYWORDS) ||
    hasSegment(normalized, "cli") ||
    hasToken(normalized, ["cli"])
  );
}

export function isBackgroundSurfacePath(normalized: string): boolean {
  return hasToken(normalized, CONCURRENCY_KEYWORDS);
}

export function isNetworkSurfacePath(normalized: string): boolean {
  return hasSegment(normalized, "api") || hasToken(normalized, INTERFACE_KEYWORDS);
}

export function isBillingPath(normalized: string): boolean {
  return hasToken(normalized, BILLING_KEYWORDS);
}

export function isIdentityPath(normalized: string): boolean {
  return isSecuritySensitivePath(normalized) || hasToken(normalized, IDENTITY_KEYWORDS);
}

export function isAsyncTaskPath(normalized: string): boolean {
  return isConcurrencyPath(normalized) || hasToken(normalized, ASYNC_TASK_KEYWORDS);
}
