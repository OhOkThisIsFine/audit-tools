import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";

const CONTRACT_FAILURE =
  "contract:attribution-contract-retirement:not-yet-satisfied";
const FIXTURE_ROOT = join(
  process.cwd(),
  "tests",
  "shared",
  "fixtures",
  "remediation-contracts",
);

interface SchemaResult {
  readonly success: boolean;
}

interface SchemaLike {
  safeParse(value: unknown): SchemaResult;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function loadJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectKeys(child)]);
}

async function optionalImport(specifier: string): Promise<Record<string, unknown> | null> {
  try {
    return (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

test("retires provider attribution and preserves a provider-agnostic execution record", async () => {
  const violations: string[] = [];
  const workload = loadJson(join(FIXTURE_ROOT, "provider-neutral-workloads.json"));
  const fixtures = Array.isArray(workload.fixtures) ? workload.fixtures : [];
  const fixture = fixtures.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).id === "attribution-free-result",
  ) as Record<string, unknown> | undefined;
  const payload = fixture?.payload;

  if (fixture?.positive_event !== "provider-agnostic-execution-record-accepted") {
    violations.push("provider-neutral execution event is missing");
  }
  if (payload === undefined) {
    violations.push("provider-neutral execution fixture is missing");
  }

  const executionModule = await optionalImport(
    "../../src/shared/types/executionRecord.js",
  );
  const schema = executionModule?.ExecutionRecordV1Alpha1Schema as
    | SchemaLike
    | undefined;
  if (schema === undefined || typeof schema.safeParse !== "function") {
    violations.push("execution-record schema is missing");
  } else if (payload !== undefined) {
    if (!schema.safeParse(payload).success) {
      violations.push("provider-neutral execution fixture is rejected");
    }
    if (
      schema.safeParse({
        ...(payload as Record<string, unknown>),
        provider: "forbidden",
      }).success
    ) {
      violations.push("execution-record schema accepts provider attribution");
    }
    const executorReported = {
      ...((payload as Record<string, unknown>).executor_reported as Record<
        string,
        unknown
      >),
      model: "forbidden",
    };
    if (
      schema.safeParse({
        ...(payload as Record<string, unknown>),
        executor_reported: executorReported,
      }).success
    ) {
      violations.push("execution-record schema accepts model attribution");
    }
  }

  const forbiddenPayloadFragments = [
    "backend",
    "endpoint",
    "model",
    "pool",
    "provider",
    "quota",
    "routing",
    "transport",
  ];
  for (const key of collectKeys(payload)) {
    const normalized = key.toLowerCase();
    if (forbiddenPayloadFragments.some((fragment) => normalized.includes(fragment))) {
      violations.push(`execution fixture carries retired key ${key}`);
    }
  }

  const sharedSource = await optionalImport("../../src/shared/index.js");
  if (sharedSource?.ExecutionRecordV1Alpha1Schema === undefined) {
    violations.push("shared source barrel omits the execution-record schema");
  }
  const sharedPackage = await optionalImport("audit-tools/shared");
  if (sharedPackage?.ExecutionRecordV1Alpha1Schema === undefined) {
    violations.push("built shared package omits the execution-record schema");
  }

  const retiredPaths = [
    "src/shared/types/attributionContract.ts",
    "src/shared/types/sessionConfig.ts",
    "tests/shared/dispatch-effectiveness-contract.test.ts",
  ];
  for (const path of retiredPaths) {
    if (existsSync(join(process.cwd(), path))) violations.push(`retired path remains: ${path}`);
  }

  const sharedIndexPath = join(process.cwd(), "src", "shared", "index.ts");
  const sharedIndex = readFileSync(sharedIndexPath, "utf8");
  const retiredExports = [
    "attributionContract",
    "AttributionTriple",
    "DispatchAttemptRow",
    "FindingVerdictRow",
    "deriveAggregates",
    "buildAttemptKey",
    "AttemptKeyInput",
  ];
  for (const retiredExport of retiredExports) {
    if (sharedIndex.includes(retiredExport)) {
      violations.push(`retired shared export remains: ${retiredExport}`);
    }
  }

  const stepContract = readFileSync(
    join(process.cwd(), "src", "shared", "types", "stepContract.ts"),
    "utf8",
  );
  if (/DispatchModelTier|DispatchModelHint|model_hint/u.test(stepContract)) {
    violations.push("shared model-tier contract remains");
  }
  const contentKey = readFileSync(
    join(process.cwd(), "src", "shared", "contentKey.ts"),
    "utf8",
  );
  if (/buildAttemptKey|AttemptKeyInput|bound_pool_id/u.test(contentKey)) {
    violations.push("provider-coupled attempt-key contract remains");
  }

  const generatedAttribution = collectFiles(join(process.cwd(), "dist")).filter((path) =>
    /attributionContract\.(?:js|d\.ts|map)$/u.test(path.replace(/\\/g, "/")),
  );
  if (generatedAttribution.length > 0) {
    violations.push(
      `stale generated attribution output remains: ${generatedAttribution
        .map((path) => relative(process.cwd(), path).replace(/\\/g, "/"))
        .join(",")}`,
    );
  }

  const retiredDeepImport = await optionalImport(
    "audit-tools/shared/types/attributionContract",
  );
  if (retiredDeepImport !== null) {
    violations.push("retired attribution deep import still resolves");
  }

  const packageJson = loadJson(join(process.cwd(), "package.json"));
  const bins = packageJson.bin as Record<string, unknown> | undefined;
  if (bins?.["audit-code"] !== "audit-code.mjs") {
    violations.push("audit-code bin was not preserved");
  }
  if (bins?.["remediate-code"] !== "remediate-code.mjs") {
    violations.push("remediate-code bin was not preserved");
  }

  const expectedModules = [
    "attribution-contract-retirement",
    "audit-zero-adapter-boundary",
    "backend-independent-remediation-planning",
    "canonical-session-intent",
    "remediation-contract-tests",
    "remediation-zero-adapter-boundary",
    "shared-content-coherence",
    "stable-task-affinity-artifacts",
  ];
  const overlapFiles = collectFiles(FIXTURE_ROOT).filter((path) =>
    /owned-overlap-[^/\\]+\.json$/u.test(path),
  );
  const overlapModules: string[] = [];
  for (const path of overlapFiles) {
    const manifest = loadJson(path);
    const declaredHash = manifest.manifest_sha256;
    delete manifest.manifest_sha256;
    if (typeof declaredHash !== "string" || sha256(stableJson(manifest)) !== declaredHash) {
      violations.push(`invalid overlap manifest hash: ${relative(process.cwd(), path)}`);
    }
    if (typeof manifest.module_id === "string") overlapModules.push(manifest.module_id);
  }
  if (stableJson(overlapModules.sort()) !== stableJson(expectedModules.sort())) {
    violations.push("the eight owned-overlap manifests are not reconciled");
  }

  const matrix = loadJson(join(FIXTURE_ROOT, "contract-matrix.json"));
  const contracts = Array.isArray(matrix.contracts) ? matrix.contracts : [];
  const retirement = contracts.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      (candidate as Record<string, unknown>).id === "attribution-contract-retirement",
  ) as Record<string, unknown> | undefined;
  const dependencies = Array.isArray(retirement?.depends_on)
    ? [...retirement.depends_on].sort()
    : [];
  if (
    stableJson(dependencies) !==
    stableJson(expectedModules.filter((id) => id !== "attribution-contract-retirement").sort())
  ) {
    violations.push("integration coordinator closure is incomplete");
  }

  if (violations.length > 0) {
    throw new Error(`${CONTRACT_FAILURE}\n${violations.sort().join("\n")}`);
  }
});
