import { createHash } from "node:crypto";

export type JsonRecord = Record<string, unknown>;
export type ByteSource = string | Uint8Array;

export interface EvidenceContractSchema {
  readonly command_schema: {
    readonly required_keys: readonly string[];
  };
  readonly test_closure_schema: {
    readonly required_keys: readonly string[];
    readonly file_entry_required_keys: readonly string[];
    readonly required_file_roles: readonly string[];
    readonly transitive_repository_roles: readonly string[];
    readonly runner_required_keys: readonly string[];
  };
  readonly production_scope_schema: {
    readonly required_keys: readonly string[];
    readonly entry_required_keys: readonly string[];
  };
  readonly red_record_schema: {
    readonly contract_version: string;
    readonly required_keys: readonly string[];
  };
  readonly green_companion_schema: {
    readonly contract_version: string;
    readonly required_keys: readonly string[];
  };
}

export interface EvidenceMaterial {
  readonly output: {
    readonly stdout: string;
    readonly stderr: string;
  };
  readonly discovered_closure_paths: readonly string[];
  readonly assignment: {
    readonly module_id: string;
    readonly test_id: string;
    readonly command: {
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly normalized_environment: Readonly<Record<string, string>>;
    };
    readonly expected_red_failure_signature: string;
  };
  readonly closure_files: Readonly<Record<string, ByteSource>>;
  readonly production_files: Readonly<Record<string, ByteSource>>;
}

export interface EvidenceBundleMaterial {
  readonly red: EvidenceMaterial;
  readonly green: EvidenceMaterial;
}

export interface ModuleContractOracle {
  readonly required_guarantees: readonly string[];
  readonly forbidden_surfaces: readonly string[];
}

export interface ModuleContractSubject {
  readonly id: string;
  readonly required_guarantees: readonly string[];
  readonly forbidden_surfaces: readonly string[];
  readonly deletion_guard: {
    readonly positive_replacement_guarantee: string;
  };
}

export interface OfflineActionDefinition {
  readonly id: string;
  readonly error_code: string;
}

export interface OfflineFailOnCallHarness {
  readonly calls: Readonly<Record<string, () => never>>;
  snapshot(): Readonly<Record<string, number>>;
  assertUntouched(): void;
}

export interface ProviderNeutralFixture {
  readonly id: string;
  readonly contract_ids: readonly string[];
  readonly positive_event: string;
  readonly payload: unknown;
}

export interface ProviderNeutralReplayResult {
  readonly positive_event: string;
  readonly consumer_seam: string;
  readonly replacement_output: unknown;
  readonly action_counts: Readonly<Record<string, number>>;
}

export interface DirtyBaselineForGate {
  readonly baseline_id: string;
  readonly captured_head: string;
  readonly manifest_sha256: string;
  readonly status_snapshot_sha256: string;
  readonly status_entries: readonly {
    readonly path: string;
    readonly status: string;
    readonly worktree_sha256: string | null;
  }[];
}

export interface OwnedOverlapForGate {
  readonly module_id: string;
  readonly baseline_id: string;
  readonly baseline_manifest_sha256: string;
  readonly immutable: boolean;
  readonly finalized: boolean;
  readonly explicitly_empty: boolean;
  readonly owned_overlaps: readonly unknown[];
  readonly manifest_sha256: string;
}

export interface WriteOnceGateOracle {
  readonly gate_manifest_sha256: string;
  readonly pre_edit_test_tree_sha256: string;
  readonly head_tests_tree_oid: string;
  readonly sealed_overlap_manifest_sha256: string;
  readonly foundation_owned_paths: readonly string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return (
      "{" +
      Object.keys(record)
        .sort(compareCodeUnits)
        .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function bytes(value: ByteSource): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

export function sha256Bytes(value: ByteSource): string {
  return createHash("sha256").update(bytes(value)).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(stableJson(value));
}

function withoutKey(value: Readonly<JsonRecord>, key: string): JsonRecord {
  const clone = structuredClone(value) as JsonRecord;
  delete clone[key];
  return clone;
}

export function recordSha256(record: Readonly<JsonRecord>): string {
  return canonicalSha256(withoutKey(record, "record_sha256"));
}

export function closureSha256(closure: Readonly<JsonRecord>): string {
  return canonicalSha256(withoutKey(closure, "closure_sha256"));
}

export function treeSha256(entries: readonly unknown[]): string {
  return canonicalSha256(entries);
}

function normalizeStream(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizedRunOutput(output: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stdout = normalizeStream(output.stdout);
  const stderr = normalizeStream(output.stderr);
  return (
    "stdout\u0000" +
    String(Buffer.byteLength(stdout, "utf8")) +
    "\u0000" +
    stdout +
    "stderr\u0000" +
    String(Buffer.byteLength(stderr, "utf8")) +
    "\u0000" +
    stderr
  );
}

export function outputSha256(output: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return sha256Bytes(normalizedRunOutput(output));
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function exactKeys(
  diagnostics: string[],
  value: unknown,
  required: readonly string[],
  path: string,
): value is JsonRecord {
  if (!isRecord(value)) {
    diagnostics.push(path + ":not-object");
    return false;
  }
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...required].sort(compareCodeUnits);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) diagnostics.push(path + ":missing:" + key);
  }
  for (const key of actual) {
    if (!expected.includes(key)) diagnostics.push(path + ":unexpected:" + key);
  }
  return true;
}

function validateCommand(
  schema: EvidenceContractSchema,
  value: unknown,
  path: string,
): string[] {
  const diagnostics: string[] = [];
  if (!exactKeys(diagnostics, value, schema.command_schema.required_keys, path)) {
    return diagnostics;
  }
  const argv = value.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    diagnostics.push(path + ":invalid-argv");
  }
  if (value.cwd !== ".") diagnostics.push(path + ":invalid-cwd");
  if (!isRecord(value.normalized_environment)) {
    diagnostics.push(path + ":invalid-environment");
  } else {
    const keys = Object.keys(value.normalized_environment);
    if (stableJson(keys) !== stableJson([...keys].sort(compareCodeUnits))) {
      diagnostics.push(path + ":environment-not-sorted");
    }
    for (const [key, entry] of Object.entries(value.normalized_environment)) {
      if (typeof entry !== "string") diagnostics.push(path + ":non-string-env:" + key);
      if (/key|password|secret|token/iu.test(key)) {
        diagnostics.push(path + ":secret-env-key:" + key);
      }
    }
  }
  return diagnostics;
}

function validateClosure(
  schema: EvidenceContractSchema,
  value: unknown,
  expectedTestId: unknown,
  material: EvidenceMaterial,
  path: string,
): string[] {
  const diagnostics: string[] = [];
  if (!exactKeys(diagnostics, value, schema.test_closure_schema.required_keys, path)) {
    return diagnostics;
  }
  if (value.test_id !== expectedTestId) diagnostics.push(path + ":test-id-mismatch");
  if (!Array.isArray(value.files)) {
    diagnostics.push(path + ":files-not-array");
    return diagnostics;
  }

  const allowedRoles = new Set([
    ...schema.test_closure_schema.required_file_roles,
    ...schema.test_closure_schema.transitive_repository_roles,
  ]);
  const seenPaths = new Set<string>();
  const roles = new Map<string, number>();
  const orderedPaths: string[] = [];
  let runnerEntrypointSha: string | undefined;

  for (const [index, entry] of value.files.entries()) {
    const entryPath = path + ".files[" + String(index) + "]";
    if (
      !exactKeys(
        diagnostics,
        entry,
        schema.test_closure_schema.file_entry_required_keys,
        entryPath,
      )
    ) {
      continue;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      diagnostics.push(entryPath + ":invalid-path");
      continue;
    }
    orderedPaths.push(entry.path);
    if (seenPaths.has(entry.path)) diagnostics.push(entryPath + ":duplicate-path");
    seenPaths.add(entry.path);

    if (typeof entry.role !== "string" || !allowedRoles.has(entry.role)) {
      diagnostics.push(entryPath + ":invalid-role");
    } else {
      roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
    }
    if (!isSha256(entry.sha256)) {
      diagnostics.push(entryPath + ":invalid-sha256");
    }

    const content = material.closure_files[entry.path];
    if (content === undefined) {
      diagnostics.push(entryPath + ":missing-content");
    } else if (entry.sha256 !== sha256Bytes(content)) {
      diagnostics.push(entryPath + ":content-sha256-mismatch");
    }
    if (entry.role === "runner_entrypoint" && typeof entry.sha256 === "string") {
      runnerEntrypointSha = entry.sha256;
    }
  }

  if (stableJson(orderedPaths) !== stableJson([...orderedPaths].sort(compareCodeUnits))) {
    diagnostics.push(path + ":files-not-sorted");
  }
  const discoveredPaths = [...material.discovered_closure_paths].sort(compareCodeUnits);
  if (
    stableJson([...seenPaths].sort(compareCodeUnits)) !== stableJson(discoveredPaths) ||
    stableJson(Object.keys(material.closure_files).sort(compareCodeUnits)) !==
      stableJson(discoveredPaths)
  ) {
    diagnostics.push(path + ":closure-path-set-mismatch");
  }
  for (const role of schema.test_closure_schema.required_file_roles) {
    if ((roles.get(role) ?? 0) !== 1) {
      diagnostics.push(path + ":required-role-count:" + role);
    }
  }

  if (
    exactKeys(
      diagnostics,
      value.runner,
      schema.test_closure_schema.runner_required_keys,
      path + ".runner",
    )
  ) {
    if (
      typeof value.runner.name !== "string" ||
      value.runner.name.length === 0 ||
      typeof value.runner.version !== "string" ||
      value.runner.version.length === 0
    ) {
      diagnostics.push(path + ".runner:invalid-identity");
    }
    if (!isSha256(value.runner.entrypoint_sha256)) {
      diagnostics.push(path + ".runner:invalid-entrypoint-sha256");
    } else if (value.runner.entrypoint_sha256 !== runnerEntrypointSha) {
      diagnostics.push(path + ".runner:entrypoint-sha256-mismatch");
    }
  }

  if (!isSha256(value.closure_sha256)) {
    diagnostics.push(path + ":invalid-closure-sha256");
  } else if (value.closure_sha256 !== closureSha256(value)) {
    diagnostics.push(path + ":closure-sha256-mismatch");
  }
  return diagnostics;
}

function validateScope(
  schema: EvidenceContractSchema,
  value: unknown,
  material: EvidenceMaterial,
  path: string,
): string[] {
  const diagnostics: string[] = [];
  if (!exactKeys(diagnostics, value, schema.production_scope_schema.required_keys, path)) {
    return diagnostics;
  }
  if (!Array.isArray(value.entries)) {
    diagnostics.push(path + ":entries-not-array");
    return diagnostics;
  }

  const seenPaths = new Set<string>();
  const orderedPaths: string[] = [];
  for (const [index, entry] of value.entries.entries()) {
    const entryPath = path + ".entries[" + String(index) + "]";
    if (
      !exactKeys(
        diagnostics,
        entry,
        schema.production_scope_schema.entry_required_keys,
        entryPath,
      )
    ) {
      continue;
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      diagnostics.push(entryPath + ":invalid-path");
      continue;
    }
    orderedPaths.push(entry.path);
    if (seenPaths.has(entry.path)) diagnostics.push(entryPath + ":duplicate-path");
    seenPaths.add(entry.path);
    if (!isSha256(entry.sha256)) diagnostics.push(entryPath + ":invalid-sha256");

    const content = material.production_files[entry.path];
    if (content === undefined) {
      diagnostics.push(entryPath + ":missing-content");
    } else if (entry.sha256 !== sha256Bytes(content)) {
      diagnostics.push(entryPath + ":content-sha256-mismatch");
    }
  }

  if (stableJson(orderedPaths) !== stableJson([...orderedPaths].sort(compareCodeUnits))) {
    diagnostics.push(path + ":entries-not-sorted");
  }
  if (!isSha256(value.tree_sha256)) {
    diagnostics.push(path + ":invalid-tree-sha256");
  } else if (value.tree_sha256 !== treeSha256(value.entries)) {
    diagnostics.push(path + ":tree-sha256-mismatch");
  }
  return diagnostics;
}

export function validateRedEvidenceRecord(
  schema: EvidenceContractSchema,
  value: unknown,
  material: EvidenceMaterial,
): string[] {
  const diagnostics: string[] = [];
  if (!exactKeys(diagnostics, value, schema.red_record_schema.required_keys, "red")) {
    return diagnostics.sort(compareCodeUnits);
  }
  if (value.contract_version !== schema.red_record_schema.contract_version) {
    diagnostics.push("red:contract-version");
  }
  if (typeof value.module_id !== "string" || value.module_id.length === 0) {
    diagnostics.push("red:module-id");
  } else if (value.module_id !== material.assignment.module_id) {
    diagnostics.push("red:matrix-module-id-mismatch");
  }
  if (typeof value.test_id !== "string" || value.test_id.length === 0) {
    diagnostics.push("red:test-id");
  } else if (value.test_id !== material.assignment.test_id) {
    diagnostics.push("red:matrix-test-id-mismatch");
  }
  diagnostics.push(...validateCommand(schema, value.command, "red.command"));
  if (stableJson(value.command) !== stableJson(material.assignment.command)) {
    diagnostics.push("red:matrix-command-mismatch");
  }
  diagnostics.push(
    ...validateClosure(
      schema,
      value.test_closure,
      value.test_id,
      material,
      "red.test_closure",
    ),
    ...validateScope(
      schema,
      value.pre_edit_production_scope,
      material,
      "red.pre_edit_production_scope",
    ),
  );
  if (!Number.isInteger(value.exit_code) || value.exit_code === 0) {
    diagnostics.push("red:exit-code-is-nonzero");
  }
  const normalizedOutput = normalizedRunOutput(material.output);
  if (
    typeof value.expected_failure_signature !== "string" ||
    value.expected_failure_signature.length === 0 ||
    !normalizedOutput.includes(value.expected_failure_signature)
  ) {
    diagnostics.push("red:output-contains-expected-failure-signature");
  }
  if (
    value.expected_failure_signature !==
    material.assignment.expected_red_failure_signature
  ) {
    diagnostics.push("red:matrix-failure-signature-mismatch");
  }
  if (!isSha256(value.output_sha256) || value.output_sha256 !== outputSha256(material.output)) {
    diagnostics.push("red:output-sha256-mismatch");
  }
  if (!isSha256(value.record_sha256) || value.record_sha256 !== recordSha256(value)) {
    diagnostics.push("red:record-sha256-mismatch");
  }
  return sortedUniqueDiagnostics(diagnostics);
}

export function validateGreenEvidenceRecord(
  schema: EvidenceContractSchema,
  value: unknown,
  material: EvidenceMaterial,
): string[] {
  const diagnostics: string[] = [];
  if (
    !exactKeys(
      diagnostics,
      value,
      schema.green_companion_schema.required_keys,
      "green",
    )
  ) {
    return diagnostics.sort(compareCodeUnits);
  }
  if (value.contract_version !== schema.green_companion_schema.contract_version) {
    diagnostics.push("green:contract-version");
  }
  if (typeof value.module_id !== "string" || value.module_id.length === 0) {
    diagnostics.push("green:module-id");
  } else if (value.module_id !== material.assignment.module_id) {
    diagnostics.push("green:matrix-module-id-mismatch");
  }
  if (typeof value.test_id !== "string" || value.test_id.length === 0) {
    diagnostics.push("green:test-id");
  } else if (value.test_id !== material.assignment.test_id) {
    diagnostics.push("green:matrix-test-id-mismatch");
  }
  diagnostics.push(
    ...validateCommand(schema, value.command, "green.command"),
    ...validateScope(
      schema,
      value.post_edit_production_scope,
      material,
      "green.post_edit_production_scope",
    ),
  );
  if (stableJson(value.command) !== stableJson(material.assignment.command)) {
    diagnostics.push("green:matrix-command-mismatch");
  }
  if (value.exit_code !== 0) diagnostics.push("green:exit-code-is-zero");
  if (!isSha256(value.test_closure_sha256)) {
    diagnostics.push("green:invalid-test-closure-sha256");
  }
  if (!isSha256(value.red_record_sha256)) {
    diagnostics.push("green:invalid-red-record-sha256");
  }
  if (!isSha256(value.output_sha256) || value.output_sha256 !== outputSha256(material.output)) {
    diagnostics.push("green:output-sha256-mismatch");
  }
  if (!isSha256(value.record_sha256) || value.record_sha256 !== recordSha256(value)) {
    diagnostics.push("green:record-sha256-mismatch");
  }
  return sortedUniqueDiagnostics(diagnostics);
}

function sortedUniqueDiagnostics(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

export function validateRedGreenEvidenceBundle(
  schema: EvidenceContractSchema,
  red: unknown,
  green: unknown,
  material: EvidenceBundleMaterial,
): string[] {
  const diagnostics = [
    ...validateRedEvidenceRecord(schema, red, material.red),
    ...validateGreenEvidenceRecord(schema, green, material.green),
  ];
  if (!isRecord(red) || !isRecord(green)) {
    return sortedUniqueDiagnostics(diagnostics);
  }

  if (red.module_id !== green.module_id) diagnostics.push("pair:same-module-id");
  if (red.test_id !== green.test_id) diagnostics.push("pair:same-test-id");

  const redCommand = isRecord(red.command) ? red.command : {};
  const greenCommand = isRecord(green.command) ? green.command : {};
  if (stableJson(redCommand.argv) !== stableJson(greenCommand.argv)) {
    diagnostics.push("pair:identical-argv");
  }
  if (redCommand.cwd !== greenCommand.cwd) diagnostics.push("pair:identical-cwd");
  if (
    stableJson(redCommand.normalized_environment) !==
    stableJson(greenCommand.normalized_environment)
  ) {
    diagnostics.push("pair:identical-normalized-environment");
  }

  const redClosure = isRecord(red.test_closure) ? red.test_closure : {};
  if (redClosure.closure_sha256 !== green.test_closure_sha256) {
    diagnostics.push("pair:identical-test-closure-sha256");
  }
  if (red.record_sha256 !== green.red_record_sha256) {
    diagnostics.push("pair:green-references-red-record-sha256");
  }

  const greenClosureDiagnostics = validateClosure(
    schema,
    redClosure,
    red.test_id,
    material.green,
    "green.test_closure",
  );
  if (greenClosureDiagnostics.length > 0) {
    diagnostics.push("pair:red-record-and-test-closure-are-read-only-after-production-mutation");
    diagnostics.push(...greenClosureDiagnostics);
  }

  return sortedUniqueDiagnostics(diagnostics);
}

export function validateContractRowAgainstOracle(
  subject: ModuleContractSubject,
  oracle: ModuleContractOracle | undefined,
): string[] {
  if (!oracle) return ["contract:unknown-module:" + subject.id];
  const diagnostics: string[] = [];
  if (
    stableJson([...subject.required_guarantees].sort(compareCodeUnits)) !==
    stableJson([...oracle.required_guarantees].sort(compareCodeUnits))
  ) {
    diagnostics.push("contract:required-guarantees:" + subject.id);
  }
  if (
    stableJson([...subject.forbidden_surfaces].sort(compareCodeUnits)) !==
    stableJson([...oracle.forbidden_surfaces].sort(compareCodeUnits))
  ) {
    diagnostics.push("contract:forbidden-surfaces:" + subject.id);
  }
  if (
    !oracle.required_guarantees.includes(
      subject.deletion_guard.positive_replacement_guarantee,
    )
  ) {
    diagnostics.push("contract:positive-replacement:" + subject.id);
  }
  return diagnostics;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createOfflineFailOnCallHarness(
  definitions: readonly OfflineActionDefinition[],
): OfflineFailOnCallHarness {
  const counts: Record<string, number> = {};
  const calls: Record<string, () => never> = {};
  for (const definition of definitions) {
    assertCondition(!Object.hasOwn(counts, definition.id), "duplicate action " + definition.id);
    counts[definition.id] = 0;
    calls[definition.id] = () => {
      counts[definition.id] = (counts[definition.id] ?? 0) + 1;
      throw new Error(definition.error_code);
    };
  }
  return {
    calls,
    snapshot: () => Object.freeze({ ...counts }),
    assertUntouched: () => {
      const called = Object.entries(counts).filter(([, count]) => count !== 0);
      if (called.length > 0) {
        throw new Error(
          "offline action invoked: " +
            called.map(([id, count]) => id + "=" + String(count)).join(","),
        );
      }
    },
  };
}

function fixtureById(
  fixtures: readonly ProviderNeutralFixture[],
  id: string,
): ProviderNeutralFixture {
  const fixture = fixtures.find((candidate) => candidate.id === id);
  assertCondition(fixture !== undefined, "missing fixture " + id);
  return fixture;
}

function canonicalizeAffinity(payload: JsonRecord): unknown {
  const input = payload.input;
  assertCondition(isRecord(input), "affinity input must be an object");
  const taskIds = input.task_ids;
  const nodes = input.nodes;
  const edges = input.edges;
  assertCondition(Array.isArray(taskIds), "affinity task ids must be an array");
  assertCondition(Array.isArray(nodes), "affinity nodes must be an array");
  assertCondition(Array.isArray(edges), "affinity edges must be an array");

  return {
    task_ids: [...taskIds].sort((left, right) =>
      compareCodeUnits(String(left), String(right)),
    ),
    nodes: nodes
      .map((entry) => {
        assertCondition(isRecord(entry), "affinity node must be an object");
        return {
          ...entry,
          file_paths: Array.isArray(entry.file_paths)
            ? [...entry.file_paths].sort((left, right) =>
                compareCodeUnits(String(left), String(right)),
              )
            : [],
          tags: Array.isArray(entry.tags)
            ? [...entry.tags].sort((left, right) =>
                compareCodeUnits(String(left), String(right)),
              )
            : [],
        } as JsonRecord;
      })
      .sort((left, right) =>
        compareCodeUnits(String(left.task_id), String(right.task_id)),
      ),
    edges: edges
      .map((entry) => {
        assertCondition(isRecord(entry), "affinity edge must be an object");
        const endpoints = [String(entry.from), String(entry.to)].sort(compareCodeUnits);
        return { ...entry, from: endpoints[0], to: endpoints[1] } as JsonRecord;
      })
      .sort((left, right) => {
        const leftKey = [
          left.from,
          left.to,
          left.kind,
          left.reason ?? "",
          left.weight,
        ].join("\u0000");
        const rightKey = [
          right.from,
          right.to,
          right.kind,
          right.reason ?? "",
          right.weight,
        ].join("\u0000");
        return compareCodeUnits(leftKey, rightKey);
      }),
  };
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function intersects(left: readonly unknown[], right: readonly unknown[]): boolean {
  const values = new Set(left.map(String));
  return right.some((entry) => values.has(String(entry)));
}

function coherenceTrace(payload: JsonRecord): unknown {
  const input = payload.input;
  assertCondition(isRecord(input), "coherence input must be an object");
  assertCondition(Array.isArray(input.items), "coherence items must be an array");
  assertCondition(
    Array.isArray(input.relationships),
    "coherence relationships must be an array",
  );
  const items = input.items
    .map((entry) => {
      assertCondition(isRecord(entry), "coherence item must be an object");
      return entry;
    })
    .sort((left, right) => compareCodeUnits(String(left.id), String(right.id)));
  const relationPairs = new Set(
    input.relationships.map((entry) => {
      assertCondition(isRecord(entry), "relationship must be an object");
      const pair = [String(entry.left), String(entry.right)].sort(compareCodeUnits);
      return pair[0] + "\u0000" + pair[1] + "\u0000" + String(entry.kind);
    }),
  );
  const candidates: Array<{ left: string; right: string; score: number }> = [];

  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const left = items[leftIndex];
      const right = items[rightIndex];
      assertCondition(left !== undefined && right !== undefined, "missing coherence item");
      const leftId = String(left.id);
      const rightId = String(right.id);
      const leftFiles = Array.isArray(left.file_paths) ? left.file_paths : [];
      const rightFiles = Array.isArray(right.file_paths) ? right.file_paths : [];
      const leftUnits = Array.isArray(left.unit_ids) ? left.unit_ids : [];
      const rightUnits = Array.isArray(right.unit_ids) ? right.unit_ids : [];
      const leftTags = Array.isArray(left.tags) ? left.tags : [];
      const rightTags = Array.isArray(right.tags) ? right.tags : [];
      let score = 0;
      if (intersects(leftFiles, rightFiles)) score += 100;
      if (intersects(leftUnits, rightUnits)) score += 80;
      if (relationPairs.has(leftId + "\u0000" + rightId + "\u0000call_adjacent")) {
        score += 70;
      }
      if (intersects(leftTags, rightTags)) score += 30;
      const leftDirectories = leftFiles.map((entry) => parentDirectory(String(entry)));
      const rightDirectories = rightFiles.map((entry) => parentDirectory(String(entry)));
      if (intersects(leftDirectories, rightDirectories)) score += 10;
      if (score >= 60) candidates.push({ left: leftId, right: rightId, score });
    }
  }
  candidates.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const first = compareCodeUnits(left.left, right.left);
    return first === 0 ? compareCodeUnits(left.right, right.right) : first;
  });

  const parent = new Map(items.map((item) => [String(item.id), String(item.id)]));
  const root = (id: string): string => {
    let current = id;
    while (parent.get(current) !== current) {
      current = parent.get(current) ?? current;
    }
    return current;
  };
  const decisions: string[] = [];
  for (const candidate of candidates) {
    const leftRoot = root(candidate.left);
    const rightRoot = root(candidate.right);
    if (leftRoot === rightRoot) {
      decisions.push("already_connected");
      continue;
    }
    const canonical = compareCodeUnits(leftRoot, rightRoot) <= 0 ? leftRoot : rightRoot;
    const other = canonical === leftRoot ? rightRoot : leftRoot;
    parent.set(other, canonical);
    decisions.push("merge");
  }
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const id = String(item.id);
    const key = root(id);
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  const components = [...groups.values()]
    .map((group) => group.sort(compareCodeUnits))
    .sort((left, right) => compareCodeUnits(left[0] ?? "", right[0] ?? ""));
  return {
    eligible_candidates: candidates,
    merge_decisions: decisions,
    components,
  };
}

export function replayProviderNeutralFixture(
  fixture: ProviderNeutralFixture,
  allFixtures: readonly ProviderNeutralFixture[],
  harness: OfflineFailOnCallHarness,
): ProviderNeutralReplayResult {
  harness.assertUntouched();
  assertCondition(isRecord(fixture.payload), fixture.id + " payload must be an object");
  let consumerSeam: string;
  let replacementOutput: unknown;

  switch (fixture.id) {
    case "session-intent-canonical": {
      consumerSeam = "shared-session-intent-loader";
      replacementOutput = fixture.payload.expected_absent;
      assertCondition(isRecord(replacementOutput), "missing absent session result");
      break;
    }
    case "task-affinity-permutation": {
      consumerSeam = "canonical-affinity-persistence";
      replacementOutput = canonicalizeAffinity(fixture.payload);
      assertCondition(
        stableJson(replacementOutput) === stableJson(fixture.payload.expected),
        "affinity canonicalization mismatch",
      );
      break;
    }
    case "coherence-golden-topology": {
      consumerSeam = "shared-content-coherence-core";
      replacementOutput = coherenceTrace(fixture.payload);
      assertCondition(
        stableJson(replacementOutput) === stableJson(fixture.payload.expected),
        "coherence trace mismatch",
      );
      break;
    }
    case "backend-independent-plan": {
      consumerSeam = "remediation-plan-from-coherence";
      const groups = fixture.payload.groups;
      const coverage = fixture.payload.coverage;
      assertCondition(Array.isArray(groups) && Array.isArray(coverage), "invalid plan");
      const groupedIds = groups.flatMap((entry) => {
        assertCondition(isRecord(entry) && Array.isArray(entry.finding_ids), "invalid group");
        return entry.finding_ids.map(String);
      });
      const coveredIds = coverage.map((entry) => {
        assertCondition(isRecord(entry), "invalid coverage");
        return String(entry.finding_id);
      });
      replacementOutput = {
        complete: stableJson([...groupedIds].sort(compareCodeUnits)) ===
          stableJson([...coveredIds].sort(compareCodeUnits)),
        membership_source: fixture.payload.membership_source,
      };
      assertCondition(
        isRecord(replacementOutput) && replacementOutput.complete === true,
        "plan coverage incomplete",
      );
      break;
    }
    case "audit-host-workload": {
      consumerSeam = "audit-host-workload-emitter";
      assertCondition(Array.isArray(fixture.payload.work_items), "missing audit work");
      replacementOutput = structuredClone(fixture.payload.work_items);
      break;
    }
    case "audit-untrusted-result": {
      consumerSeam = "audit-result-ingestion";
      const workload = fixtureById(allFixtures, "audit-host-workload");
      assertCondition(isRecord(workload.payload), "audit workload payload");
      const items = workload.payload.work_items;
      assertCondition(Array.isArray(items) && isRecord(items[0]), "audit work item");
      assertCondition(
        fixture.payload.work_item_id === items[0].id &&
          isRecord(items[0].prompt) &&
          fixture.payload.prompt_sha256 === items[0].prompt.sha256,
        "audit result binding mismatch",
      );
      replacementOutput = { ingested: true, work_item_id: fixture.payload.work_item_id };
      break;
    }
    case "remediation-host-workload": {
      consumerSeam = "remediation-frontier-handoff";
      assertCondition(Array.isArray(fixture.payload.work_items), "missing remediation work");
      replacementOutput = structuredClone(fixture.payload.work_items);
      break;
    }
    case "remediation-host-result": {
      consumerSeam = "remediation-result-ingestion";
      const workload = fixtureById(allFixtures, "remediation-host-workload");
      assertCondition(isRecord(workload.payload), "remediation workload payload");
      const items = workload.payload.work_items;
      assertCondition(Array.isArray(items) && isRecord(items[0]), "remediation work item");
      assertCondition(isRecord(items[0].prompt), "remediation prompt");
      assertCondition(isRecord(fixture.payload.commit_evidence), "commit evidence");
      assertCondition(
        fixture.payload.work_item_id === items[0].id &&
          fixture.payload.prompt_sha256 === items[0].prompt.sha256 &&
          fixture.payload.commit_evidence.before === items[0].baseline_commit,
        "remediation result binding mismatch",
      );
      replacementOutput = { accepted: true, work_item_id: fixture.payload.work_item_id };
      break;
    }
    case "attribution-free-result": {
      consumerSeam = "provider-agnostic-execution-recorder";
      assertCondition(fixture.payload.outcome === "accepted", "execution record rejected");
      replacementOutput = {
        recorded: true,
        record_id: fixture.payload.record_id,
      };
      break;
    }
    default:
      throw new Error("unhandled fixture " + fixture.id);
  }

  harness.assertUntouched();
  return {
    positive_event: fixture.positive_event,
    consumer_seam: consumerSeam,
    replacement_output: replacementOutput,
    action_counts: harness.snapshot(),
  };
}

export function validateWriteOnceGate(
  gate: unknown,
  overlap: OwnedOverlapForGate,
  baseline: DirtyBaselineForGate,
  oracle: WriteOnceGateOracle,
): string[] {
  const diagnostics: string[] = [];
  if (!isRecord(gate)) return ["write-once:gate-not-object"];
  const gateWithoutHash = withoutKey(gate, "gate_manifest_sha256");
  if (canonicalSha256(gateWithoutHash) !== gate.gate_manifest_sha256) {
    diagnostics.push("write-once:gate-manifest-sha256");
  }
  if (gate.gate_manifest_sha256 !== oracle.gate_manifest_sha256) {
    diagnostics.push("write-once:independent-gate-seal");
  }
  if (gate.module_id !== "remediation-contract-tests") {
    diagnostics.push("write-once:module-id");
  }
  if (gate.baseline_id !== baseline.baseline_id) {
    diagnostics.push("write-once:baseline-id");
  }
  if (gate.baseline_manifest_sha256 !== baseline.manifest_sha256) {
    diagnostics.push("write-once:baseline-manifest");
  }
  if (gate.baseline_status_snapshot_sha256 !== baseline.status_snapshot_sha256) {
    diagnostics.push("write-once:baseline-status");
  }
  if (gate.sealed_overlap_manifest_sha256 !== oracle.sealed_overlap_manifest_sha256) {
    diagnostics.push("write-once:sealed-overlap-oracle");
  }
  if (gate.sealed_overlap_manifest_sha256 !== overlap.manifest_sha256) {
    diagnostics.push("write-once:overlap-expanded-or-replaced");
  }
  if (
    overlap.module_id !== "remediation-contract-tests" ||
    overlap.baseline_id !== baseline.baseline_id ||
    overlap.baseline_manifest_sha256 !== baseline.manifest_sha256 ||
    overlap.immutable !== true ||
    overlap.finalized !== true ||
    overlap.explicitly_empty !== true ||
    overlap.owned_overlaps.length !== 0
  ) {
    diagnostics.push("write-once:overlap-contract");
  }

  const snapshot = gate.pre_edit_test_tree;
  if (!isRecord(snapshot)) {
    diagnostics.push("write-once:test-tree-not-object");
    return sortedUniqueDiagnostics(diagnostics);
  }
  const snapshotWithoutHash = withoutKey(snapshot, "tree_sha256");
  if (canonicalSha256(snapshotWithoutHash) !== snapshot.tree_sha256) {
    diagnostics.push("write-once:test-tree-sha256");
  }
  if (snapshot.tree_sha256 !== oracle.pre_edit_test_tree_sha256) {
    diagnostics.push("write-once:independent-test-tree-seal");
  }
  if (
    snapshot.captured_head !== baseline.captured_head ||
    snapshot.head_tests_tree_oid !== oracle.head_tests_tree_oid
  ) {
    diagnostics.push("write-once:captured-head-tree");
  }

  const expectedOverrides = baseline.status_entries
    .filter((entry) => entry.path.startsWith("tests/") && entry.status !== "??")
    .map((entry) => ({
      path: entry.path,
      status: entry.status,
      worktree_sha256: entry.worktree_sha256,
    }));
  const expectedUntracked = baseline.status_entries
    .filter((entry) => entry.path.startsWith("tests/") && entry.status === "??")
    .map((entry) => entry.path);
  if (stableJson(snapshot.dirty_test_overrides) !== stableJson(expectedOverrides)) {
    diagnostics.push("write-once:dirty-test-overrides");
  }
  if (stableJson(snapshot.untracked_test_paths) !== stableJson(expectedUntracked)) {
    diagnostics.push("write-once:untracked-test-paths");
  }
  if (stableJson(gate.foundation_owned_paths_absent) !== stableJson(oracle.foundation_owned_paths)) {
    diagnostics.push("write-once:foundation-path-oracle");
  }
  if (
    oracle.foundation_owned_paths.some((path) =>
      baseline.status_entries.some((entry) => entry.path === path),
    )
  ) {
    diagnostics.push("write-once:foundation-path-present-in-baseline");
  }
  if (gate.finalized_before_first_test_edit !== true || gate.write_once !== true) {
    diagnostics.push("write-once:freeze-boundary");
  }
  return sortedUniqueDiagnostics(diagnostics);
}
