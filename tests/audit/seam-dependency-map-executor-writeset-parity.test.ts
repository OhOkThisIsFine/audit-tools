/**
 * Cross-module seam test: dependency-map-executor-writeset-parity
 *
 * Verifies that ARTIFACT_DEPENDENTS_MAP (dependencyMap.ts) and the executor
 * write-sets (artifacts_written arrays across all executor modules) remain in
 * parity. Drift between the two breaks staleness propagation silently.
 *
 * Seam contract (N-TEST-SEAM-dependency-map-executor-writeset-parity):
 *
 *   PARITY-1: Every artifact filename in any executor's artifacts_written is a
 *             known filename (present in ARTIFACT_DEFINITIONS, or declared
 *             lifecycle-written / side-channel). Typos or stale names are caught
 *             at test time rather than silently writing unknown artifacts.
 *
 *   PARITY-2: Every artifact referenced as an upstream in ARTIFACT_DEPENDS_ON_MAP
 *             (the canonical hand-authored DAG) is writable — by a named executor
 *             or by a declared lifecycle path. A stale upstream name means consumers
 *             silently never re-stale. Overlaps with PARITY-3 to provide independent
 *             verification from the canonical-direction source.
 *
 *   PARITY-2b: Every KEY in ARTIFACT_DEPENDS_ON_MAP (a dependent artifact whose
 *             freshness is defined by its upstreams) is a known filename. A stale
 *             key means computeArtifactMetadata tracks freshness for a file that
 *             no executor produces, so the real artifact is never re-staled.
 *
 *   PARITY-3: Every KEY in ARTIFACT_DEPENDENTS_MAP that has at least one
 *             downstream dependent must be writable — either by a named
 *             executor or by a declared lifecycle path. Dead keys (with
 *             non-empty dependents but no writer) indicate a stale rename or
 *             deletion.
 *
 * The lifecycle and side-channel exemptions are NOT enumerated here: they are
 * derived from LIFECYCLE_PRODUCTIONS and the registry's `side_channel`
 * declarations (src/audit/orchestrator/executors.ts), so a member list in this
 * header would be a second home that decays. A lifecycle entry an executor
 * actually writes is refused by
 * tests/audit/executor-artifact-production-declaration.test.ts.
 *
 *   PARITY-4: All filenames appearing as VALUES in ARTIFACT_DEPENDENTS_MAP
 *             (the downstream dependents) are known filenames. A stale value
 *             means staleness would propagate to a non-existent artifact.
 *
 *   PARITY-5: Specific high-value edges that guard known regressions exist
 *             in both the executor write-sets and the dependency map.
 */

import { test, expect } from "vitest";

// ── Import live modules ───────────────────────────────────────────────────────

const { ARTIFACT_DEPENDENTS_MAP, ARTIFACT_DEPENDS_ON_MAP } = await import("../../src/audit/orchestrator/dependencyMap.js");
const { ARTIFACT_DEFINITIONS, AUDIT_REPORT_FILENAME } = await import("../../src/audit/io/artifacts.js");
const { EXECUTOR_REGISTRY, LIFECYCLE_PRODUCTIONS } = await import("../../src/audit/orchestrator/executors.js");
const { AGENT_FEEDBACK_FILENAME } = await import("audit-tools/shared");
const { extractExecutorWriteSets } = await import("../../scripts/shared/executor-write-sites.mjs");

// ── Canonical known filenames ─────────────────────────────────────────────────

/** Every filename the artifact registry knows about plus the two special files. */
const KNOWN_FILENAMES = new Set([
  ...Object.values(ARTIFACT_DEFINITIONS).map((def) => def.fileName),
  AGENT_FEEDBACK_FILENAME,
  AUDIT_REPORT_FILENAME,
]);

/**
 * Files whose writes are managed OUTSIDE named executor return values — the
 * environment probe, worker appends, and advanceAudit's own supervisor pair.
 * They appear as keys in ARTIFACT_DEPENDENTS_MAP but must not be required to
 * appear in any executor's artifacts_written. Declared once as
 * LIFECYCLE_PRODUCTIONS on the executor registry, so this test and the generated
 * producer table read the same list.
 */
const LIFECYCLE_WRITTEN_FILES = new Set(
  LIFECYCLE_PRODUCTIONS.map((entry) => entry.artifact),
);

/**
 * Side-channel host-facing files that executors may write to disk as an
 * informational channel but which are NOT tracked in ARTIFACT_DEFINITIONS
 * or the dependency DAG. They are intentionally excluded from bundle tracking
 * and staleness propagation. PARITY-1 must not flag these as unknown. Declared
 * on the executor registry (role "side_channel"), each carrying the reason it
 * sits outside the DAG.
 */
const SIDE_CHANNEL_FILES = new Set(
  EXECUTOR_REGISTRY.flatMap((executor) =>
    executor.produces
      .filter((production) => production.role === "side_channel")
      .map((production) => production.artifact),
  ),
);

// ── Build the combined executor write-set ────────────────────────────────────

/**
 * The write-set extraction lives in `scripts/shared/executor-write-sites.mjs` —
 * one home, keyed per EXECUTOR rather than per source file, so the four executors
 * sharing `structureExecutors.ts` and the CLI-site writes of the host-delegation
 * executors are attributed individually. That extraction is pinned against the
 * registry's `produces` declaration by
 * `tests/audit/executor-artifact-production-declaration.test.ts`; this seam test
 * consumes its union to check the dependency DAG.
 */
const ALL_EXECUTOR_WRITTEN = new Set<string>(
  [...extractExecutorWriteSets().values()].flatMap((written) => [...written]),
);

// ── Pre-compute useful sets for the tests ────────────────────────────────────

/** All artifact filenames that appear as downstream dependents (values in the map). */
const DEPENDENTS_MAP_VALUES: (readonly string[] | undefined)[] = Object.values(ARTIFACT_DEPENDENTS_MAP);
const ALL_DOWNSTREAM_VALUES = new Set(DEPENDENTS_MAP_VALUES.flatMap((v) => v ?? []));

/** Keys in the map that have at least one downstream dependent. */
const MAP_KEYS_WITH_DEPENDENTS = Object.entries(ARTIFACT_DEPENDENTS_MAP)
  .filter(([, deps]) => deps && deps.length > 0)
  .map(([key]) => key);

// ── PARITY-1: executor write-sets only reference known filenames ──────────────

test("PARITY-1: every artifact in an executor artifacts_written is a known filename (ARTIFACT_DEFINITIONS or special lifecycle files)", () => {
  const unknown = [...ALL_EXECUTOR_WRITTEN].filter(
    (name) => !KNOWN_FILENAMES.has(name) && !SIDE_CHANNEL_FILES.has(name),
  );
  expect(unknown.sort(), `Executor artifacts_written contains unknown filenames: [${unknown.join(", ")}]. ` +
      "Either add them to ARTIFACT_DEFINITIONS, add to SIDE_CHANNEL_FILES if intentionally untracked, " +
      "or fix the typo.").toEqual([]);
});

// ── PARITY-2: every upstream referenced in ARTIFACT_DEPENDS_ON_MAP is writable ──

test("PARITY-2: every artifact referenced as an upstream in ARTIFACT_DEPENDS_ON_MAP is writable (executor or lifecycle)", () => {
  // ARTIFACT_DEPENDENTS_MAP is DERIVED from ARTIFACT_DEPENDS_ON_MAP — there is
  // exactly one hand-authored adjacency representation. PARITY-2 therefore checks
  // the canonical source directly: every artifact that appears as an upstream value
  // in ARTIFACT_DEPENDS_ON_MAP must be provided by some executor or by a lifecycle
  // path. A stale rename in the map (old upstream name still listed as a value but
  // no executor writes it) causes consumers to never see a fresh version of that
  // upstream — silently breaking staleness propagation.
  //
  // This intentionally overlaps with PARITY-3 (which checks ARTIFACT_DEPENDENTS_MAP
  // keys) to provide independent verification from the canonical direction.
  const allWritable = new Set([...ALL_EXECUTOR_WRITTEN, ...LIFECYCLE_WRITTEN_FILES]);

  // Collect every unique upstream filename referenced in ARTIFACT_DEPENDS_ON_MAP.
  const allUpstreams = new Set(Object.values(ARTIFACT_DEPENDS_ON_MAP).flat());

  const mismatches = [];
  for (const upstream of allUpstreams) {
    if (!allWritable.has(upstream)) {
      mismatches.push(upstream);
    }
  }

  expect(mismatches.sort(), `ARTIFACT_DEPENDS_ON_MAP references upstreams that nothing writes: [${mismatches.join(", ")}]. ` +
      "Staleness propagation from these artifacts can never fire. " +
      "If an artifact was renamed, update ARTIFACT_DEPENDS_ON_MAP values to the new filename " +
      "AND update the executor's artifacts_written to match.").toEqual([]);
});

// ── PARITY-2b: every key in ARTIFACT_DEPENDS_ON_MAP is a known filename ─────────

test("PARITY-2b: every key in ARTIFACT_DEPENDS_ON_MAP (dependent artifact) is a known filename — no stale renames in the canonical DAG", () => {
  // ARTIFACT_DEPENDS_ON_MAP is hand-authored. If an artifact is renamed (new name
  // added to ARTIFACT_DEFINITIONS; old name removed) but its entry in the map is
  // not updated, the stale key remains. computeArtifactMetadata would compare
  // upstream revisions for an artifact name that no executor produces, so the
  // staleness check for that artifact silently becomes a no-op.
  //
  // Check: every KEY of ARTIFACT_DEPENDS_ON_MAP (the dependent artifact — one
  // that depends on upstreams) must appear in KNOWN_FILENAMES. Keys are the
  // artifacts whose freshness is computed by comparing upstream revisions; a key
  // that is no longer in ARTIFACT_DEFINITIONS means those freshness comparisons
  // are wasted and the real artifact is never re-staled.
  const staleMapKeys = [];
  for (const depArtifact of Object.keys(ARTIFACT_DEPENDS_ON_MAP)) {
    if (!KNOWN_FILENAMES.has(depArtifact)) {
      staleMapKeys.push(depArtifact);
    }
  }
  expect(staleMapKeys.sort(), `ARTIFACT_DEPENDS_ON_MAP keys reference artifact names not in ARTIFACT_DEFINITIONS: [${staleMapKeys.join(", ")}]. ` +
      "These entries are stale — either add the artifact to ARTIFACT_DEFINITIONS or remove the key from the DAG.").toEqual([]);
});

// ── PARITY-3: every map key with dependents has at least one writer ────────────

test("PARITY-3: every ARTIFACT_DEPENDENTS_MAP key that has downstream dependents is writable (by an executor or lifecycle path)", () => {
  const allWritable = new Set([...ALL_EXECUTOR_WRITTEN, ...LIFECYCLE_WRITTEN_FILES]);

  const deadKeys = MAP_KEYS_WITH_DEPENDENTS.filter((key) => !allWritable.has(key));

  expect(deadKeys.sort(), `ARTIFACT_DEPENDENTS_MAP keys with dependents that nothing writes: [${deadKeys.join(", ")}]. ` +
      "These staleness edges can never fire. If the artifact was renamed or deleted, update the map.").toEqual([]);
});

// ── PARITY-4: all dependency-map values are known filenames ──────────────────

test("PARITY-4: all downstream filenames in ARTIFACT_DEPENDENTS_MAP are known artifact filenames", () => {
  const unknownDownstreams = [...ALL_DOWNSTREAM_VALUES].filter(
    (name) => !KNOWN_FILENAMES.has(name),
  );

  expect(unknownDownstreams.sort(), `ARTIFACT_DEPENDENTS_MAP references unknown downstream filenames: [${unknownDownstreams.join(", ")}]. ` +
      "Staleness would propagate to a non-existent artifact. Fix the typo or add to ARTIFACT_DEFINITIONS.").toEqual([]);
});

// ── PARITY-5: specific high-value edges (regression guards) ──────────────────

test("PARITY-5a: planning executor writes scope.json AND scope.json → coverage_matrix.json, audit_tasks.json edges exist", () => {
  // ARC-cebe3421-3 regression guard.
  expect(ALL_EXECUTOR_WRITTEN.has("scope.json"), "planning executor must list scope.json in artifacts_written").toBeTruthy();
  const scopeDeps = ARTIFACT_DEPENDENTS_MAP["scope.json"];
  expect(Array.isArray(scopeDeps) && scopeDeps.includes("coverage_matrix.json"), "scope.json → coverage_matrix.json direct edge must exist in ARTIFACT_DEPENDENTS_MAP").toBeTruthy();
  expect(Array.isArray(scopeDeps) && scopeDeps.includes("audit_tasks.json"), "scope.json → audit_tasks.json direct edge must exist (ARC-cebe3421-3: scope change with identical coverage must still re-stale tasks)").toBeTruthy();
});

test("PARITY-5b: structure executor writes graph_bundle.json AND graph_bundle.json → analyzer_capability.json edge exists", () => {
  expect(ALL_EXECUTOR_WRITTEN.has("graph_bundle.json"), "structure or graph-enrichment executor must list graph_bundle.json in artifacts_written").toBeTruthy();
  const graphDeps = ARTIFACT_DEPENDENTS_MAP["graph_bundle.json"];
  expect(Array.isArray(graphDeps) && graphDeps.includes("analyzer_capability.json"), "graph_bundle.json → analyzer_capability.json edge must exist (enrichment re-stale guard)").toBeTruthy();
});

test("PARITY-5c: synthesis executor writes audit-findings.json AND audit-findings.json → synthesis-narrative.json edge exists", () => {
  expect(ALL_EXECUTOR_WRITTEN.has("audit-findings.json"), "synthesis executor must list audit-findings.json in artifacts_written").toBeTruthy();
  const findingsDeps = ARTIFACT_DEPENDENTS_MAP["audit-findings.json"];
  expect(Array.isArray(findingsDeps) && findingsDeps.includes("synthesis-narrative.json"), "audit-findings.json → synthesis-narrative.json edge must exist (fresh synthesis re-stales narrative)").toBeTruthy();
});

test("PARITY-5d: syntax-resolution executor writes external_analyzer_results.json AND that file is a key with dependents", () => {
  expect(ALL_EXECUTOR_WRITTEN.has("external_analyzer_results.json"), "syntax-resolution executor must list external_analyzer_results.json in artifacts_written").toBeTruthy();
  const deps = ARTIFACT_DEPENDENTS_MAP["external_analyzer_results.json"];
  expect(Array.isArray(deps) && deps.length > 0, "external_analyzer_results.json must have at least one dependent in ARTIFACT_DEPENDENTS_MAP").toBeTruthy();
});

test("PARITY-5e: intake executor writes repo_manifest.json AND repo_manifest.json → file_disposition.json edge exists", () => {
  // repo_manifest.json is written via a local variable in intakeExecutors.ts
  // (not an inline literal). This test verifies our extraction caught it.
  expect(ALL_EXECUTOR_WRITTEN.has("repo_manifest.json"), "intake executor must list repo_manifest.json in artifacts_written " +
      "(extraction may have missed the local-variable pattern — check extractExecutorWriteSets)").toBeTruthy();
  const repoDeps = ARTIFACT_DEPENDENTS_MAP["repo_manifest.json"];
  expect(Array.isArray(repoDeps) && repoDeps.includes("file_disposition.json"), "repo_manifest.json → file_disposition.json edge must exist").toBeTruthy();
});

test("PARITY-5f: agent-feedback.jsonl (lifecycle file) is a key in ARTIFACT_DEPENDENTS_MAP pointing to audit-report.md", () => {
  // Verify the lifecycle file is correctly wired so a reflection appended after
  // synthesis re-stales the markdown report exactly once.
  const feedbackDeps = ARTIFACT_DEPENDENTS_MAP[AGENT_FEEDBACK_FILENAME];
  expect(Array.isArray(feedbackDeps) && feedbackDeps.includes(AUDIT_REPORT_FILENAME), `${AGENT_FEEDBACK_FILENAME} → ${AUDIT_REPORT_FILENAME} edge must exist so worker reflections re-stale the report`).toBeTruthy();
});
