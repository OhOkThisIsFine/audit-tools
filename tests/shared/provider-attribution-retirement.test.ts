import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";
import { stableStringify } from "audit-tools/shared";

const CONTRACT_FAILURE =
  "contract:attribution-contract-retirement:not-yet-satisfied";
const FIXTURE_ROOT = join(
  process.cwd(),
  "tests",
  "shared",
  "fixtures",
  "remediation-contracts",
);

// The ONE production serializer. This file carried its own copy, which was
// doubly wrong: `.sort()` with no comparator is UTF-16 code-unit order by
// accident (the same as `compareCodeUnits`, but by luck rather than by
// statement), and it omitted production's `undefined` normalization — so a
// fixture with a present-but-undefined field hashed differently here than under
// the producer. `src/shared/stableStringify.ts` states the rule directly:
// "There must be exactly ONE such serializer — never write a second."
function stableJson(value: unknown): string {
  return stableStringify(value);
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

/**
 * The outcome of probing a module specifier. The three cases are DISTINCT
 * because collapsing them is a false-retirement generator (TST-248adff9): a
 * catch-all `null` reported a module that still ships but throws during
 * evaluation as cleanly gone, and inverted on the expected-present probes, where
 * an environment/build failure surfaced as "the barrel omits the schema".
 */
type ImportProbe =
  | { readonly status: "loaded"; readonly module: Record<string, unknown> }
  | { readonly status: "not_found" }
  | { readonly status: "threw"; readonly detail: string };

/**
 * Node reports an unresolvable specifier with one of these codes. Anything else
 * — including an error with no `code` — is the module RESOLVING and then failing
 * during evaluation, which is not evidence of retirement.
 */
const RESOLUTION_FAILURE_CODES: ReadonlySet<string> = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);

async function optionalImport(specifier: string): Promise<ImportProbe> {
  try {
    return {
      status: "loaded",
      module: (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>,
    };
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && RESOLUTION_FAILURE_CODES.has(code)) {
      return { status: "not_found" };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "threw",
      detail: `${typeof code === "string" ? code : "no-code"}: ${message.split("\n")[0]}`,
    };
  }
}

test("retires provider attribution and the producerless execution-record plane, preserving the submission ledger that replaced it", async () => {
  const violations: string[] = [];
  const workload = loadJson(join(FIXTURE_ROOT, "provider-neutral-workloads.json"));
  const fixtures = Array.isArray(workload.fixtures) ? workload.fixtures : [];

  // The execution-record fixture was retired WITH the plane it exercised: a
  // fixture whose only consumer was the schema being deleted is residue, and
  // leaving it would advertise a contract nothing reads. Its replacement is
  // asserted positively below.
  for (const fixture of fixtures) {
    if (
      fixture !== null &&
      typeof fixture === "object" &&
      (fixture as Record<string, unknown>).id === "attribution-free-result"
    ) {
      violations.push("retired execution-record fixture remains");
    }
  }

  // RETIRED PATHS, source and test. A module that a guard deletes must not come
  // back by any route, so the absence is asserted on the FILE, not only on the
  // export: `src/shared/types/executionRecord.ts` and the run-ledger pair were
  // the producerless provenance plane (its writer was deleted in 623a93a0 and
  // its last caller in 91826f1c; re-creating a producer would re-create retired
  // substrate, so the plane is retired rather than fed).
  const retiredPaths = [
    "src/shared/types/attributionContract.ts",
    "src/shared/types/sessionConfig.ts",
    "tests/shared/dispatch-effectiveness-contract.test.ts",
    "src/shared/types/executionRecord.ts",
    "src/shared/types/runLedger.ts",
    "src/audit/supervisor/runLedger.ts",
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
    // The provenance plane's exports, retired at the same boundary.
    "executionRecord",
    "ExecutionRecordV1Alpha1",
    "ExecutionRecordOutcome",
    "ExecutorReportedStatement",
    "EXECUTION_RECORD_CONTRACT_VERSION",
    "runLedger",
    "RunLedger",
    "RunLedgerEntry",
    "RunLedgerStatus",
    "RUN_LEDGER_STATUSES",
  ];
  for (const retiredExport of retiredExports) {
    if (sharedIndex.includes(retiredExport)) {
      violations.push(`retired shared export remains: ${retiredExport}`);
    }
  }

  // The retired names must not resurface in a SCHEMA's `required` either — a
  // host handing over `run_ledger` was re-advertising a path no writer ever
  // produced (the loader's empty result was indistinguishable from a run that
  // recorded nothing). Checked on the SHIPPED schema, which is the artifact a
  // host actually reads.
  for (const schemaName of [
    "audit-code-v1alpha1.schema.json",
  ] as const) {
    const schemaText = readFileSync(join(process.cwd(), "schemas", schemaName), "utf8");
    for (const retiredName of ["run_ledger", "allowed_mcp_tools"]) {
      if (schemaText.includes(retiredName)) {
        violations.push(`retired name remains in ${schemaName}: ${retiredName}`);
      }
    }
  }

  // The operator-handoff and status surfaces that ADVERTISED the ledger must
  // stop naming it — a retirement that leaves the text is not a retirement.
  for (const [path, retiredName] of [
    ["src/audit/supervisor/operatorHandoff.ts", "run_ledger"],
    ["src/audit/cli/statusCommand.ts", "runLedger"],
    ["src/audit/cli/statusCommand.ts", "recent_runs"],
  ] as const) {
    if (readFileSync(join(process.cwd(), path), "utf8").includes(retiredName)) {
      violations.push(`retired ledger advertisement remains in ${path}: ${retiredName}`);
    }
  }

  // The POSITIVE REPLACEMENT. The plane's guarantee is not simply deleted — the
  // submission ledger is the live append-only record of what happened to each
  // submission, and it is the surface that answered the question the run ledger
  // was defined to answer. Asserting its presence is what keeps this guard a
  // REPLACEMENT guarantee rather than a bare absence check.
  for (const [label, specifier] of [
    ["shared source barrel", "../../src/shared/index.js"],
    ["built shared package", "audit-tools/shared"],
  ] as const) {
    const probe = await optionalImport(specifier);
    if (probe.status === "not_found") {
      violations.push(`${label} does not resolve: ${specifier}`);
    } else if (probe.status === "threw") {
      violations.push(`${label} failed to evaluate (${probe.detail})`);
    } else if (typeof probe.module.readSubmissionLedger !== "function") {
      violations.push(`${label} omits the submission-ledger reader`);
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
  for (const fixture of fixtures) {
    if (fixture === null || typeof fixture !== "object") continue;
    for (const key of collectKeys((fixture as Record<string, unknown>).payload)) {
      const normalized = key.toLowerCase();
      if (forbiddenPayloadFragments.some((fragment) => normalized.includes(fragment))) {
        violations.push(`provider-neutral fixture carries retired key ${key}`);
      }
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

  // Only a RESOLUTION failure is evidence of retirement. A module that resolves
  // and then throws is still shipped — reporting it as retired is the false
  // green TST-248adff9 names.
  //
  // The THREW message states only what the probe established. It used to say
  // "still resolves but throws", asserting a resolution fact the probe never
  // tested for: a `not_found` whose error code is outside
  // RESOLUTION_FAILURE_CODES (a future Node code, a bundler's own spelling)
  // lands in this branch, and the message then claimed resolution for a module
  // that does not resolve at all. The fail DIRECTION was safe — a violation
  // either way — but an unestablished claim in a guard's own refusal text is
  // how a later reader comes to trust a check that is not checking that
  // (CP-NODE-25 residual).
  const retiredDeepImport = await optionalImport(
    "audit-tools/shared/types/attributionContract",
  );
  if (retiredDeepImport.status === "loaded") {
    violations.push("retired attribution deep import still resolves");
  } else if (retiredDeepImport.status === "threw") {
    violations.push(
      `retired attribution deep import did not fail with a resolution-failure code — it may still ` +
        `ship (this probe cannot distinguish "resolves then throws" from an unrecognized ` +
        `not-found code) (${retiredDeepImport.detail})`,
    );
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
