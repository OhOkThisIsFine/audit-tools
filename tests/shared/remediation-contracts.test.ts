/**
 * Green foundation contracts for the zero-adapter/shared-coherence remediation.
 *
 * Production-specific failing assertions belong to their consuming modules.
 * This suite validates only immutable evidence metadata, reusable offline
 * fixtures, dependency expansion, and structural guarantee/deletion guards.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, test } from "vitest";
import {
  canonicalSha256 as harnessCanonicalSha256,
  closureSha256,
  createOfflineFailOnCallHarness,
  outputSha256,
  recordSha256,
  replayProviderNeutralFixture,
  sha256Bytes,
  treeSha256,
  validateContractRowAgainstOracle,
  validateGreenEvidenceRecord,
  validateRedEvidenceRecord,
  validateRedGreenEvidenceBundle,
  validateWriteOnceGate,
  type EvidenceBundleMaterial,
  type ModuleContractOracle,
  type ProviderNeutralFixture,
  type WriteOnceGateOracle,
} from "./fixtures/remediation-contracts/contract-harness.js";

interface CommandSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly normalized_environment: Readonly<Record<string, string>>;
  readonly test_file: string;
}

interface ContractRow {
  readonly id: string;
  readonly block_id: string;
  readonly depends_on: readonly string[];
  readonly test_contract: {
    readonly test_id: string;
    readonly focused_command: CommandSpec;
    readonly expected_red_failure_signature: string;
  };
  readonly module_green_commands: readonly string[];
  readonly final_gate_profile: string;
  readonly required_guarantees: readonly string[];
  readonly forbidden_surfaces: readonly string[];
  readonly deletion_guard: {
    readonly guard_id: string;
    readonly positive_replacement_guarantee: string;
  };
  readonly fixture_ids: readonly string[];
}

interface ContractMatrix {
  readonly contract_version: string;
  readonly immutable: boolean;
  readonly foundation_module: string;
  readonly command_defaults: {
    readonly cwd: string;
    readonly normalized_environment: Readonly<Record<string, string>>;
  };
  readonly approved_defaults: {
    readonly session_intent: {
      readonly canonical_path: string;
      readonly absent_result: {
        readonly status: string;
        readonly intent: {
          readonly review_mode: string;
          readonly observability: string;
        };
      };
      readonly configured_status: string;
      readonly accepted_keys: readonly string[];
      readonly review_mode_values: readonly string[];
      readonly observability_values: readonly string[];
      readonly invalid_present_behavior: string;
      readonly maximum_filesystem_reads: number;
    };
    readonly remediation_planning: {
      readonly membership_source: string;
      readonly token_estimate_basis: string;
      readonly token_estimate_effect: string;
      readonly backend_fit: boolean;
      readonly transport_sizing: boolean;
    };
  };
  readonly coherence_policy: {
    readonly evidence_classes: Readonly<Record<string, number>>;
    readonly graph_kind_aliases: Readonly<Record<string, readonly string[]>>;
    readonly threshold: number;
    readonly pair_score_rule: string;
    readonly candidate_order: readonly string[];
    readonly merge_predicate: string;
    readonly canonical_root: string;
    readonly final_member_order: string;
    readonly final_component_order: string;
    readonly consumer_role: string;
    readonly capacity_or_annotation_veto: boolean;
    readonly golden_trace: {
      readonly eligible_candidates: readonly {
        readonly left: string;
        readonly right: string;
        readonly score: number;
      }[];
      readonly merge_decisions: readonly string[];
      readonly components: readonly (readonly string[])[];
    };
  };
  readonly gate_profiles: readonly {
    readonly id: string;
    readonly commands: readonly {
      readonly id: string;
      readonly argv: readonly string[];
    }[];
  }[];
  readonly contracts: readonly ContractRow[];
}

interface DependencyNode {
  readonly id: string;
  readonly block_id: string;
  readonly depends_on: readonly string[];
  readonly invariant_count: number;
  readonly failure_mode_count: number;
}

interface DependencyManifest {
  readonly contract_version: string;
  readonly immutable: boolean;
  readonly foundation_module: string;
  readonly nodes: readonly DependencyNode[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly obligation_expansion: {
    readonly obligation_id_patterns: Readonly<Record<string, string>>;
    readonly rules: readonly {
      readonly id: string;
      readonly applies_to: string;
      readonly add_dependencies: string;
    }[];
    readonly special_final_gate: {
      readonly obligation_id: string;
      readonly depends_on: readonly string[];
      readonly explicitly_excludes: readonly string[];
    };
  };
}

interface WorkloadFixture {
  readonly id: string;
  readonly contract_ids: readonly string[];
  readonly positive_event: string;
  readonly payload: unknown;
}

interface WorkloadFixtures {
  readonly contract_version: string;
  readonly immutable: boolean;
  readonly spy_contract: {
    readonly mode: string;
    readonly required_call_count: number;
    readonly forbidden_actions: readonly {
      readonly id: string;
      readonly error_code: string;
    }[];
  };
  readonly forbidden_payload_key_fragments: readonly string[];
  readonly fixtures: readonly WorkloadFixture[];
}

interface DirtyHunk {
  readonly hunk_id: string;
  readonly source: string;
  readonly header: string;
  readonly patch_sha256: string;
}

interface DirtyEntry {
  readonly path: string;
  readonly original_path: string | null;
  readonly status: string;
  readonly head_sha256: string | null;
  readonly index_sha256: string | null;
  readonly worktree_sha256: string | null;
  readonly head_bytes: number | null;
  readonly index_bytes: number | null;
  readonly worktree_bytes: number | null;
  readonly binary_patch_sha256: string;
  readonly hunks: readonly DirtyHunk[];
}

interface DirtyBaseline {
  readonly contract_version: string;
  readonly baseline_id: string;
  readonly capture_boundary: string;
  readonly captured_branch: string;
  readonly captured_head: string;
  readonly hash_algorithm: string;
  readonly patch_digest_format: string;
  readonly hunk_identity_format: string;
  readonly status_format: string;
  readonly status_snapshot_sha256: string;
  readonly path_count: number;
  readonly worktree_was_clean: boolean;
  readonly immutable: boolean;
  readonly status_entries: readonly DirtyEntry[];
  readonly manifest_sha256: string;
}

interface OwnedOverlap {
  readonly contract_version: string;
  readonly module_id: string;
  readonly baseline_id: string;
  readonly baseline_manifest_sha256: string;
  readonly capture_boundary: string;
  readonly immutable: boolean;
  readonly finalized: boolean;
  readonly explicitly_empty: boolean;
  readonly owned_overlaps: readonly unknown[];
  readonly manifest_sha256: string;
}

interface EvidenceContract {
  readonly contract_version: string;
  readonly schema_status: string;
  readonly immutable: boolean;
  readonly hash_algorithm: string;
  readonly canonicalization: string;
  readonly production_red_claims: readonly unknown[];
  readonly red_records: readonly unknown[];
  readonly green_companions: readonly unknown[];
  readonly command_schema: {
    readonly required_keys: readonly string[];
    readonly constraints: Readonly<Record<string, string>>;
  };
  readonly test_closure_schema: {
    readonly required_keys: readonly string[];
    readonly file_entry_required_keys: readonly string[];
    readonly required_file_roles: readonly string[];
    readonly transitive_repository_roles: readonly string[];
    readonly runner_required_keys: readonly string[];
    readonly closure_rule: string;
    readonly digest_rule: string;
  };
  readonly production_scope_schema: {
    readonly required_keys: readonly string[];
    readonly entry_required_keys: readonly string[];
    readonly digest_rule: string;
  };
  readonly red_record_schema: {
    readonly contract_version: string;
    readonly required_keys: readonly string[];
    readonly constraints: Readonly<Record<string, string>>;
  };
  readonly green_companion_schema: {
    readonly contract_version: string;
    readonly required_keys: readonly string[];
    readonly constraints: Readonly<Record<string, string>>;
  };
  readonly cross_record_invariants: readonly string[];
}

interface Artifact<T> {
  readonly raw: string;
  readonly value: T;
}

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/remediation-contracts/", import.meta.url),
);

function loadArtifact<T>(name: string): Artifact<T> {
  const raw = readFileSync(join(FIXTURE_ROOT, name), "utf8");
  return { raw, value: JSON.parse(raw) as T };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function expectSortedUnique(values: readonly string[], label: string): void {
  expect(values, label + " must be code-unit sorted and duplicate-free").toEqual(
    sortedUnique(values),
  );
}

function expectExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  expect(Object.keys(value).sort(compareCodeUnits), label).toEqual(
    [...expected].sort(compareCodeUnits),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort(compareCodeUnits)
        .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutKey(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const clone = structuredClone(value) as Record<string, unknown>;
  delete clone[key];
  return clone;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function collectObjectKeys(
  value: unknown,
  path = "$",
): Array<{ readonly key: string; readonly path: string }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectObjectKeys(entry, path + "[" + String(index) + "]"),
    );
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [
    { key, path: path + "." + key },
    ...collectObjectKeys(child, path + "." + key),
  ]);
}

interface CandidateSurface {
  readonly guarantees: readonly string[];
  readonly surfaces: readonly string[];
}

function evaluateCandidate(
  contract: ModuleContractOracle,
  candidate: CandidateSurface,
): string[] {
  const guarantees = new Set(candidate.guarantees);
  const surfaces = new Set(candidate.surfaces);
  return [
    ...contract.required_guarantees
      .filter((guarantee) => !guarantees.has(guarantee))
      .map((guarantee) => "missing:" + guarantee),
    ...contract.forbidden_surfaces
      .filter((surface) => surfaces.has(surface))
      .map((surface) => "forbidden:" + surface),
  ].sort(compareCodeUnits);
}

const matrixArtifact = loadArtifact<ContractMatrix>("contract-matrix.json");
const dependencyArtifact =
  loadArtifact<DependencyManifest>("dependency-manifest.json");
const workloadArtifact =
  loadArtifact<WorkloadFixtures>("provider-neutral-workloads.json");
const baselineArtifact =
  loadArtifact<DirtyBaseline>("dirty-worktree-baseline.json");
const overlapArtifact =
  loadArtifact<OwnedOverlap>("owned-overlap-remediation-contract-tests.json");
const evidenceArtifact =
  loadArtifact<EvidenceContract>("red-run-evidence.json");
const writeOnceGateArtifact = loadArtifact<Record<string, unknown>>(
  "write-once-gate-remediation-contract-tests.json",
);

const matrix = matrixArtifact.value;
const dependencyManifest = dependencyArtifact.value;
const workloads = workloadArtifact.value;
const baseline = baselineArtifact.value;
const overlap = overlapArtifact.value;
const evidence = evidenceArtifact.value;
const writeOnceGate = writeOnceGateArtifact.value;

const PRODUCTION_MODULE_IDS = [
  "attribution-contract-retirement",
  "audit-zero-adapter-boundary",
  "backend-independent-remediation-planning",
  "canonical-session-intent",
  "remediation-zero-adapter-boundary",
  "shared-content-coherence",
  "stable-task-affinity-artifacts",
] as const;

const ALL_MODULE_IDS = [
  "attribution-contract-retirement",
  "audit-zero-adapter-boundary",
  "backend-independent-remediation-planning",
  "canonical-session-intent",
  "remediation-contract-tests",
  "remediation-zero-adapter-boundary",
  "shared-content-coherence",
  "stable-task-affinity-artifacts",
] as const;

const APPROVED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "attribution-contract-retirement": [
    "audit-zero-adapter-boundary",
    "backend-independent-remediation-planning",
    "canonical-session-intent",
    "remediation-contract-tests",
    "remediation-zero-adapter-boundary",
    "shared-content-coherence",
    "stable-task-affinity-artifacts",
  ],
  "audit-zero-adapter-boundary": [
    "canonical-session-intent",
    "remediation-contract-tests",
    "shared-content-coherence",
    "stable-task-affinity-artifacts",
  ],
  "backend-independent-remediation-planning": [
    "remediation-contract-tests",
    "shared-content-coherence",
  ],
  "canonical-session-intent": ["remediation-contract-tests"],
  "remediation-contract-tests": [],
  "remediation-zero-adapter-boundary": [
    "backend-independent-remediation-planning",
    "canonical-session-intent",
    "remediation-contract-tests",
    "shared-content-coherence",
  ],
  "shared-content-coherence": [
    "remediation-contract-tests",
    "stable-task-affinity-artifacts",
  ],
  "stable-task-affinity-artifacts": ["remediation-contract-tests"],
};

const EXPECTED_FOCUSED_COMMANDS: Readonly<Record<string, string>> = {
  "attribution-contract-retirement":
    "npx vitest run tests/shared/provider-attribution-retirement.test.ts",
  "audit-zero-adapter-boundary":
    "npx vitest run tests/audit/host-handoff.test.ts",
  "backend-independent-remediation-planning":
    "npx vitest run tests/remediate/backend-independent-planning.test.ts",
  "canonical-session-intent":
    "npx vitest run tests/shared/session-intent.test.ts",
  "remediation-zero-adapter-boundary":
    "npx vitest run tests/remediate/host-handoff.test.ts",
  "shared-content-coherence":
    "npx vitest run tests/shared/content-coherence.test.ts",
  "stable-task-affinity-artifacts":
    "npx vitest run tests/shared/task-affinity-artifacts.test.ts",
};
const FINALIZED_CONTRACT_ORACLES: Readonly<
  Record<string, ModuleContractOracle>
> = {
  "attribution-contract-retirement": {
    required_guarantees: [
      "all_eight_overlap_manifests_reconciled",
      "clean_build_and_package_absence",
      "final_behavioral_gate_coverage",
      "final_static_reachability_scan",
      "integration_coordinator_closure",
      "provider_agnostic_execution_record",
      "retired_attribution_deep_import_absent",
      "retired_attribution_export_absent",
      "retired_attribution_fixture_absent",
      "retired_attribution_generated_output_absent",
      "retired_attribution_test_residue_absent",
      "retired_attribution_type_absent",
      "unrelated_shared_apis_and_bins_preserved",
    ],
    forbidden_surfaces: [
      "backend_attribution",
      "model_attribution",
      "provider_attribution",
      "provider_coupled_source_attribution",
      "retired_attribution_alias",
      "retired_attribution_shim",
      "stale_dist_deep_import",
      "transport_attribution",
    ],
  },
  "audit-zero-adapter-boundary": {
    required_guarantees: [
      "canonical_affinity_and_coherence_consumed",
      "complete_host_workload_emission",
      "deterministic_obligations_preserved",
      "durable_root_contained_host_artifacts",
      "host_owned_semantic_review",
      "idempotent_result_ingestion",
      "not_configured_uses_approved_defaults",
      "prompt_bound_result_validation",
      "provider_neutral_task_metadata",
      "shared_session_loader_once",
      "untrusted_result_validation",
    ],
    forbidden_surfaces: [
      "backend_pool",
      "execution_adapters",
      "headless_launch",
      "hybrid_routing",
      "leases",
      "model_hint",
      "provider_attempt",
      "provider_factory",
      "provider_probe",
      "provider_roster",
      "quota_admission",
      "quota_pause",
      "rolling_dispatch",
      "routing",
      "source_pool",
      "spawn_substrate",
      "transport_config",
    ],
  },
  "backend-independent-remediation-planning": {
    required_guarantees: [
      "affected_file_integrity",
      "canonical_coherence_membership_preserved",
      "complete_plan_from_coherence",
      "deterministic_local_token_estimates",
      "exhaustive_mutually_exclusive_coverage",
      "provider_neutral_work_blocks",
      "strict_structured_findings_validation",
      "zero_backend_inputs",
    ],
    forbidden_surfaces: [
      "backend_fit_partitioning",
      "backend_window_config",
      "capacity_admission",
      "context_window_input",
      "model_fit_partitioning",
      "provider_repartitioning",
      "second_partition_algorithm",
      "transport_sizing",
    ],
  },
  "canonical-session-intent": {
    required_guarantees: [
      "bounded_single_read",
      "canonical_path_only",
      "configured_or_not_configured_result",
      "cwd_independent_supplied_root",
      "invalid_present_fails_closed_path_qualified",
      "legacy_fallback_rejection",
      "observability_standard_default",
      "review_intent_never_authorizes_execution",
      "review_mode_attended_default",
      "shared_strict_loader",
      "unknown_key_rejection",
      "zero_process_network_or_provider_actions",
    ],
    forbidden_surfaces: [
      "alternate_session_config_path",
      "audit_local_session_loader",
      "backend_window_input",
      "legacy_session_config_fallback",
      "model_roster_input",
      "permissive_unknown_keys",
      "provider_input",
      "quota_input",
      "remediation_local_session_loader",
      "transport_input",
    ],
  },
  "remediation-zero-adapter-boundary": {
    required_guarantees: [
      "all_eligible_host_work_emission",
      "commit_evidence_validation",
      "dependency_and_phase_safety",
      "host_owned_execution_choices",
      "not_configured_uses_approved_defaults",
      "prompt_binding_validation",
      "provider_neutral_work_items",
      "self_contained_host_handoff",
      "strict_current_state_schema",
      "test_evidence_validation",
      "unsupported_retired_state_rejection",
      "worktree_binding_validation",
    ],
    forbidden_surfaces: [
      "backend_pool",
      "execution_adapters",
      "headless_launch",
      "leases",
      "legacy_state_migration",
      "legacy_state_recognizer",
      "provider_factory",
      "provider_launch",
      "quota_admission",
      "quota_terminal",
      "retired_state_shim",
      "rolling_dispatch",
      "routing",
      "spawn_substrate",
      "transport_config",
    ],
  },
  "shared-content-coherence": {
    required_guarantees: [
      "annotations_aggregate_after_membership",
      "canonical_candidate_ordering",
      "canonical_component_membership",
      "canonical_pair_ordering",
      "canonical_union_ordering",
      "consumer_projection_only",
      "deterministic_acyclic_dependencies_and_seams",
      "deterministic_shared_coherence_core",
      "every_item_exactly_once",
      "exact_six_class_score_table",
      "golden_trace_exact",
      "identical_audit_and_findings_core_trace",
      "systemic_findings_remain_in_component",
      "threshold_60",
    ],
    forbidden_surfaces: [
      "annotation_driven_membership",
      "audit_local_coherence_algorithm",
      "backend_window_fit_scoring",
      "capacity_or_size_veto",
      "consumer_regrouping",
      "environment_or_filesystem_input",
      "implicit_unknown_relation_weight",
      "insertion_order_tie_break",
      "provider_or_quota_input",
      "remediation_local_coherence_algorithm",
    ],
  },
  "stable-task-affinity-artifacts": {
    required_guarantees: [
      "all_persistence_and_hash_callers_canonicalized",
      "canonical_affinity_edges_full_tuple",
      "canonical_affinity_nodes",
      "canonical_nested_set_arrays",
      "canonical_persisted_audit_tasks",
      "copied_inputs",
      "deterministic_artifact_hashes",
      "duplicate_task_id_rejection",
      "edge_endpoint_integrity",
      "inert_validation_command_metadata_only",
      "locale_independent_complete_comparators",
      "semantic_graph_fields_preserved",
    ],
    forbidden_surfaces: [
      "caller_owned_input_mutation",
      "command_availability_membership",
      "executable_discovery",
      "insertion_order_hashing",
      "locale_dependent_sort",
      "provider_lookup",
      "reference_aliasing",
      "runtime_command_launch",
      "unsorted_affinity_artifacts",
      "unsorted_nested_set_arrays",
    ],
  },
};

const FINALIZED_OBLIGATION_COUNTS: Readonly<
  Record<string, { readonly invariants: number; readonly failures: number }>
> = {
  "attribution-contract-retirement": { invariants: 9, failures: 4 },
  "audit-zero-adapter-boundary": { invariants: 11, failures: 5 },
  "backend-independent-remediation-planning": { invariants: 8, failures: 4 },
  "canonical-session-intent": { invariants: 8, failures: 4 },
  "remediation-contract-tests": { invariants: 9, failures: 5 },
  "remediation-zero-adapter-boundary": { invariants: 10, failures: 5 },
  "shared-content-coherence": { invariants: 10, failures: 4 },
  "stable-task-affinity-artifacts": { invariants: 9, failures: 4 },
};

const FINALIZED_OBLIGATION_PATTERNS = {
  completion_sentinel: "OBL-<module>-contract",
  invariant: "OBL-<module>-inv-<one-based-index>",
  failure_mode: "OBL-<module>-fail-<one-based-index>",
} as const;

const FINALIZED_EXPANSION_RULES = [
  {
    id: "direct-producer-inheritance",
    applies_to: "every-non-foundation-module-obligation",
    add_dependencies: "each-direct-producer-completion-sentinel",
  },
  {
    id: "completion-sentinel-closure",
    applies_to: "every-module-completion-sentinel",
    add_dependencies: "every-local-invariant-and-failure-mode-obligation",
  },
  {
    id: "foundation-root",
    applies_to: "every-foundation-module-obligation",
    add_dependencies: "no-producer-completion-sentinel",
  },
] as const;

const FINALIZED_SPECIAL_FINAL_DEPENDENCIES = [
  "OBL-remediation-contract-tests-contract",
  "OBL-canonical-session-intent-contract",
  "OBL-stable-task-affinity-artifacts-contract",
  "OBL-shared-content-coherence-contract",
  "OBL-backend-independent-remediation-planning-contract",
  "OBL-audit-zero-adapter-boundary-contract",
  "OBL-remediation-zero-adapter-boundary-contract",
  "OBL-attribution-contract-retirement-inv-1",
  "OBL-attribution-contract-retirement-inv-2",
  "OBL-attribution-contract-retirement-inv-3",
  "OBL-attribution-contract-retirement-inv-4",
  "OBL-attribution-contract-retirement-inv-5",
  "OBL-attribution-contract-retirement-inv-6",
  "OBL-attribution-contract-retirement-inv-8",
  "OBL-attribution-contract-retirement-fail-1",
  "OBL-attribution-contract-retirement-fail-2",
  "OBL-attribution-contract-retirement-fail-3",
  "OBL-attribution-contract-retirement-fail-4",
] as const;


test("the immutable matrix covers all seven production modules and names exact commands and gates", () => {
  expectExactKeys(
    matrix,
    [
      "approved_defaults",
      "coherence_policy",
      "command_defaults",
      "contract_version",
      "contracts",
      "foundation_module",
      "gate_profiles",
      "immutable",
    ],
    "contract matrix fields",
  );
  expect(matrix.contract_version).toBe(
    "zero-adapter-remediation-contract-matrix/v1",
  );
  expect(matrix.immutable).toBe(true);
  expect(matrix.foundation_module).toBe("remediation-contract-tests");
  expect(matrix.contracts.map((contract) => contract.id)).toEqual(
    PRODUCTION_MODULE_IDS,
  );

  const profile = matrix.gate_profiles.find(
    (candidate) => candidate.id === "whole-repository-v1",
  );
  expect(profile).toBeDefined();
  if (!profile) throw new Error("missing whole repository gate profile");

  expect(profile.commands).toEqual([
    { id: "source-typecheck", argv: ["npm", "run", "check"] },
    { id: "test-typecheck", argv: ["npm", "run", "check:tests"] },
    { id: "lint", argv: ["npm", "run", "check:lint"] },
    { id: "dead-code", argv: ["npm", "run", "check:deadcode"] },
    { id: "dependency-graph", argv: ["npm", "run", "check:depgraph"] },
    { id: "full-suite", argv: ["npm", "test"] },
    { id: "tarball-smoke", argv: ["npm", "run", "pack:smoke"] },
    {
      id: "packaged-audit-smoke",
      argv: ["npm", "run", "smoke:packaged-audit-code"],
    },
    {
      id: "packaged-remediation-smoke",
      argv: ["npm", "run", "smoke:packaged-remediate-code"],
    },
    {
      id: "handoff-parity",
      argv: ["npm", "run", "check:handoff-roadmap"],
    },
  ]);

  for (const contract of matrix.contracts) {
    expectExactKeys(
      contract,
      [
        "block_id",
        "deletion_guard",
        "depends_on",
        "final_gate_profile",
        "fixture_ids",
        "forbidden_surfaces",
        "id",
        "module_green_commands",
        "required_guarantees",
        "test_contract",
      ],
      "contract row " + contract.id,
    );
    expect(contract.block_id).toBe("CP-BLOCK-" + contract.id);
    expect(contract.depends_on).toEqual(APPROVED_DEPENDENCIES[contract.id]);
    expectSortedUnique(contract.depends_on, contract.id + ".depends_on");
    expectSortedUnique(
      contract.required_guarantees,
      contract.id + ".required_guarantees",
    );
    expectSortedUnique(
      contract.forbidden_surfaces,
      contract.id + ".forbidden_surfaces",
    );
    expectSortedUnique(contract.fixture_ids, contract.id + ".fixture_ids");
    expect(contract.required_guarantees).toContain(
      contract.deletion_guard.positive_replacement_guarantee,
    );
    expect(contract.final_gate_profile).toBe(profile.id);

    const focused = contract.test_contract.focused_command;
    expect(focused.argv.join(" ")).toBe(EXPECTED_FOCUSED_COMMANDS[contract.id]);
    expect(focused.cwd).toBe(".");
    expect(focused.normalized_environment).toEqual({
      CI: "1",
      NO_COLOR: "1",
      TZ: "UTC",
    });
    expect(contract.module_green_commands[0]).toBe(
      EXPECTED_FOCUSED_COMMANDS[contract.id],
    );
  }
});

test("approved session defaults, planning defaults, and coherence topology are exact", () => {
  expect(matrix.approved_defaults.session_intent).toEqual({
    canonical_path: ".audit-tools/audit/session-config.json",
    absent_result: {
      status: "not_configured",
      intent: { review_mode: "attended", observability: "standard" },
    },
    configured_status: "configured",
    accepted_keys: ["observability", "review_mode"],
    review_mode_values: ["attended", "autonomous"],
    observability_values: ["standard", "verbose"],
    invalid_present_behavior: "path-qualified-error-without-fallback",
    maximum_filesystem_reads: 1,
  });
  expect(matrix.approved_defaults.remediation_planning).toEqual({
    membership_source: "shared-content-coherence/findings-projection",
    token_estimate_basis:
      "canonical-unique-physical-file-bytes-plus-finding-count",
    token_estimate_effect: "advisory-only",
    backend_fit: false,
    transport_sizing: false,
  });
  expect(matrix.coherence_policy.evidence_classes).toEqual({
    call_import_reference_adjacency: 70,
    same_directory: 10,
    shared_critical_flow: 60,
    shared_file: 100,
    shared_semantic_tag_or_same_lens: 30,
    shared_unit: 80,
  });
  expect(matrix.coherence_policy.threshold).toBe(60);
  expect(matrix.coherence_policy.candidate_order).toEqual([
    "score-desc",
    "min-item-id-code-unit-asc",
    "max-item-id-code-unit-asc",
  ]);
  expect(matrix.coherence_policy.merge_predicate).toBe("roots-differ");
  expect(matrix.coherence_policy.consumer_role).toBe("projection-only");
  expect(matrix.coherence_policy.capacity_or_annotation_veto).toBe(false);
  expect(matrix.coherence_policy.golden_trace).toEqual({
    eligible_candidates: [
      { left: "a", right: "c", score: 120 },
      { left: "a", right: "b", score: 110 },
      { left: "d", right: "e", score: 70 },
    ],
    merge_decisions: ["merge", "merge", "merge"],
    components: [
      ["a", "b", "c"],
      ["d", "e"],
    ],
  });
});

describe.each(matrix.contracts)("$id structural contract", (contract) => {
  const oracle = FINALIZED_CONTRACT_ORACLES[contract.id];
  if (!oracle) throw new Error("missing finalized oracle for " + contract.id);

  it("accepts the complete green structural surface", () => {
    expect(
      evaluateCandidate(oracle, {
        guarantees: oracle.required_guarantees,
        surfaces: [],
      }),
    ).toEqual([]);
  });

  it("detects mutation of every required guarantee", () => {
    for (const guarantee of oracle.required_guarantees) {
      expect(
        evaluateCandidate(oracle, {
          guarantees: oracle.required_guarantees.filter(
            (candidate) => candidate !== guarantee,
          ),
          surfaces: [],
        }),
        contract.id + " must reject removal of " + guarantee,
      ).toEqual(["missing:" + guarantee]);
    }
  });

  it("detects mutation across every deletion boundary", () => {
    for (const surface of oracle.forbidden_surfaces) {
      expect(
        evaluateCandidate(oracle, {
          guarantees: oracle.required_guarantees,
          surfaces: [surface],
        }),
        contract.id + " must reject reintroduction of " + surface,
      ).toEqual(["forbidden:" + surface]);
    }
  });

  it("rejects fixture-side guard mutations against the independent oracle", () => {
    expect(validateContractRowAgainstOracle(contract, oracle)).toEqual([]);
    for (const guarantee of oracle.required_guarantees) {
      const mutated = {
        ...contract,
        required_guarantees: contract.required_guarantees.filter(
          (candidate) => candidate !== guarantee,
        ),
      };
      expect(validateContractRowAgainstOracle(mutated, oracle)).toContain(
        "contract:required-guarantees:" + contract.id,
      );
    }
    for (const surface of oracle.forbidden_surfaces) {
      const mutated = {
        ...contract,
        forbidden_surfaces: contract.forbidden_surfaces.filter(
          (candidate) => candidate !== surface,
        ),
      };
      expect(validateContractRowAgainstOracle(mutated, oracle)).toContain(
        "contract:forbidden-surfaces:" + contract.id,
      );
    }
  });
});

function moduleObligationIds(moduleId: string): string[] {
  const counts = FINALIZED_OBLIGATION_COUNTS[moduleId];
  if (!counts) throw new Error("missing obligation count oracle for " + moduleId);
  return [
    "OBL-" + moduleId + "-contract",
    ...Array.from(
      { length: counts.invariants },
      (_, index) => "OBL-" + moduleId + "-inv-" + String(index + 1),
    ),
    ...Array.from(
      { length: counts.failures },
      (_, index) => "OBL-" + moduleId + "-fail-" + String(index + 1),
    ),
  ];
}

function expandObligationDependencies(): Map<string, string[]> {
  const expanded = new Map<string, string[]>();

  for (const moduleId of ALL_MODULE_IDS) {
    const producerSentinels = (APPROVED_DEPENDENCIES[moduleId] ?? []).map(
      (dependency) => "OBL-" + dependency + "-contract",
    );
    const local = moduleObligationIds(moduleId).filter(
      (id) => id !== "OBL-" + moduleId + "-contract",
    );

    for (const obligationId of moduleObligationIds(moduleId)) {
      const dependencies = [...producerSentinels];
      if (obligationId === "OBL-" + moduleId + "-contract") {
        dependencies.push(...local);
      }
      expanded.set(obligationId, sortedUnique(dependencies));
    }
  }

  expanded.set(
    "OBL-attribution-contract-retirement-inv-7",
    [...FINALIZED_SPECIAL_FINAL_DEPENDENCIES],
  );
  return expanded;
}

function dependencyOracleDiagnostics(candidate: DependencyManifest): string[] {
  const diagnostics: string[] = [];
  if (
    stableStringify(candidate.obligation_expansion.obligation_id_patterns) !==
    stableStringify(FINALIZED_OBLIGATION_PATTERNS)
  ) {
    diagnostics.push("dependency:obligation-patterns");
  }
  if (
    stableStringify(candidate.obligation_expansion.rules) !==
    stableStringify(FINALIZED_EXPANSION_RULES)
  ) {
    diagnostics.push("dependency:expansion-rules");
  }
  for (const moduleId of ALL_MODULE_IDS) {
    const node = candidate.nodes.find((entry) => entry.id === moduleId);
    const counts = FINALIZED_OBLIGATION_COUNTS[moduleId];
    if (!node || !counts) {
      diagnostics.push("dependency:missing-node:" + moduleId);
      continue;
    }
    if (
      node.invariant_count !== counts.invariants ||
      node.failure_mode_count !== counts.failures
    ) {
      diagnostics.push("dependency:counts:" + moduleId);
    }
    if (
      stableStringify(node.depends_on) !==
      stableStringify(APPROVED_DEPENDENCIES[moduleId])
    ) {
      diagnostics.push("dependency:producers:" + moduleId);
    }
  }
  if (
    stableStringify(
      candidate.obligation_expansion.special_final_gate.depends_on,
    ) !== stableStringify(FINALIZED_SPECIAL_FINAL_DEPENDENCIES)
  ) {
    diagnostics.push("dependency:special-final-gate");
  }
  return diagnostics.sort(compareCodeUnits);
}

test("the module DAG and normative obligation expansion are exact and acyclic", () => {
  expectExactKeys(
    dependencyManifest,
    [
      "contract_version",
      "edges",
      "foundation_module",
      "immutable",
      "nodes",
      "obligation_expansion",
    ],
    "dependency manifest fields",
  );
  expect(dependencyManifest.contract_version).toBe(
    "zero-adapter-remediation-dependencies/v1",
  );
  expect(dependencyManifest.obligation_expansion.obligation_id_patterns).toEqual(
    FINALIZED_OBLIGATION_PATTERNS,
  );
  expect(dependencyManifest.obligation_expansion.rules).toEqual(
    FINALIZED_EXPANSION_RULES,
  );
  expect(dependencyManifest.nodes.map((node) => node.id)).toEqual(
    ALL_MODULE_IDS,
  );

  for (const node of dependencyManifest.nodes) {
    expect(node.depends_on).toEqual(APPROVED_DEPENDENCIES[node.id]);
    expect(node.invariant_count).toBe(
      FINALIZED_OBLIGATION_COUNTS[node.id]?.invariants,
    );
    expect(node.failure_mode_count).toBe(
      FINALIZED_OBLIGATION_COUNTS[node.id]?.failures,
    );
    const matrixRow = matrix.contracts.find((row) => row.id === node.id);
    if (node.id === dependencyManifest.foundation_module) {
      expect(matrixRow).toBeUndefined();
    } else {
      expect(matrixRow?.depends_on).toEqual(node.depends_on);
    }
  }

  const derivedEdges = dependencyManifest.nodes
    .flatMap((node) =>
      node.depends_on.map((dependency) => ({
        from: dependency,
        to: node.id,
      })),
    )
    .sort((left, right) => {
      const from = compareCodeUnits(left.from, right.from);
      return from === 0 ? compareCodeUnits(left.to, right.to) : from;
    });
  expect(dependencyManifest.edges).toEqual(derivedEdges);
  expect(dependencyManifest.edges).toHaveLength(21);

  const expanded = expandObligationDependencies();
  const known = new Set(expanded.keys());
  for (const [obligationId, dependencies] of expanded) {
    for (const dependency of dependencies) {
      expect(known.has(dependency), obligationId + " -> " + dependency).toBe(true);
    }
  }

  for (const node of dependencyManifest.nodes) {
    const producerSentinels = node.depends_on.map(
      (dependency) => "OBL-" + dependency + "-contract",
    );
    for (const obligationId of moduleObligationIds(node.id)) {
      expect(expanded.get(obligationId)).toEqual(
        expect.arrayContaining(producerSentinels),
      );
    }

    const completion = "OBL-" + node.id + "-contract";
    const local = moduleObligationIds(node.id).filter((id) => id !== completion);
    expect(expanded.get(completion)).toEqual(
      sortedUnique([...producerSentinels, ...local]),
    );
  }

  const complete = new Set<string>();
  while (complete.size < expanded.size) {
    const ready = [...expanded.entries()]
      .filter(
        ([id, dependencies]) =>
          !complete.has(id) &&
          dependencies.every((dependency) => complete.has(dependency)),
      )
      .map(([id]) => id)
      .sort(compareCodeUnits);
    expect(ready, "expanded obligation graph must remain acyclic").not.toEqual([]);
    for (const id of ready) complete.add(id);
  }
  expect(complete.size).toBe(expanded.size);
});

test("the special final-gate prerequisite list is exact and excludes its sentinel and itself", () => {
  const special = dependencyManifest.obligation_expansion.special_final_gate;
  expect(special).toEqual({
    obligation_id: "OBL-attribution-contract-retirement-inv-7",
    depends_on: [
      "OBL-remediation-contract-tests-contract",
      "OBL-canonical-session-intent-contract",
      "OBL-stable-task-affinity-artifacts-contract",
      "OBL-shared-content-coherence-contract",
      "OBL-backend-independent-remediation-planning-contract",
      "OBL-audit-zero-adapter-boundary-contract",
      "OBL-remediation-zero-adapter-boundary-contract",
      "OBL-attribution-contract-retirement-inv-1",
      "OBL-attribution-contract-retirement-inv-2",
      "OBL-attribution-contract-retirement-inv-3",
      "OBL-attribution-contract-retirement-inv-4",
      "OBL-attribution-contract-retirement-inv-5",
      "OBL-attribution-contract-retirement-inv-6",
      "OBL-attribution-contract-retirement-inv-8",
      "OBL-attribution-contract-retirement-fail-1",
      "OBL-attribution-contract-retirement-fail-2",
      "OBL-attribution-contract-retirement-fail-3",
      "OBL-attribution-contract-retirement-fail-4",
    ],
    explicitly_excludes: [
      "OBL-attribution-contract-retirement-contract",
      "OBL-attribution-contract-retirement-inv-7",
    ],
  });
  for (const excluded of special.explicitly_excludes) {
    expect(special.depends_on).not.toContain(excluded);
  }
});

test("independent obligation oracles reject count, pattern, rule, producer, and final-gate drift", () => {
  expect(dependencyOracleDiagnostics(dependencyManifest)).toEqual([]);

  const countMutation = structuredClone(dependencyManifest);
  const countNode = countMutation.nodes.find(
    (node) => node.id === "shared-content-coherence",
  );
  if (!countNode) throw new Error("missing count mutation node");
  (countNode as { invariant_count: number }).invariant_count += 1;
  expect(dependencyOracleDiagnostics(countMutation)).toContain(
    "dependency:counts:shared-content-coherence",
  );

  const patternMutation = structuredClone(dependencyManifest);
  (
    patternMutation.obligation_expansion.obligation_id_patterns as Record<
      string,
      string
    >
  ).invariant = "fixture-controlled-pattern";
  expect(dependencyOracleDiagnostics(patternMutation)).toContain(
    "dependency:obligation-patterns",
  );

  const ruleMutation = structuredClone(dependencyManifest);
  const firstRule = ruleMutation.obligation_expansion.rules[0];
  if (!firstRule) throw new Error("missing expansion rule");
  (firstRule as { add_dependencies: string }).add_dependencies = "none";
  expect(dependencyOracleDiagnostics(ruleMutation)).toContain(
    "dependency:expansion-rules",
  );

  const producerMutation = structuredClone(dependencyManifest);
  const producerNode = producerMutation.nodes.find(
    (node) => node.id === "canonical-session-intent",
  );
  if (!producerNode) throw new Error("missing producer mutation node");
  (producerNode as unknown as { depends_on: string[] }).depends_on = [];
  expect(dependencyOracleDiagnostics(producerMutation)).toContain(
    "dependency:producers:canonical-session-intent",
  );

  const finalMutation = structuredClone(dependencyManifest);
  (
    finalMutation.obligation_expansion.special_final_gate as unknown as {
      depends_on: string[];
    }
  ).depends_on = [];
  expect(dependencyOracleDiagnostics(finalMutation)).toContain(
    "dependency:special-final-gate",
  );
});

interface ForbiddenSpies {
  readonly counts: Record<string, number>;
  readonly calls: Readonly<Record<string, () => never>>;
}

function createForbiddenSpies(): ForbiddenSpies {
  const counts: Record<string, number> = {};
  const calls: Record<string, () => never> = {};
  for (const action of workloads.spy_contract.forbidden_actions) {
    counts[action.id] = 0;
    calls[action.id] = () => {
      counts[action.id] = (counts[action.id] ?? 0) + 1;
      throw new Error(action.error_code);
    };
  }
  return { counts, calls };
}

function replayPositiveFixture(
  fixture: WorkloadFixture,
  spies: ForbiddenSpies,
): string {
  expect(Object.values(spies.counts).every((count) => count === 0)).toBe(true);
  const payload = fixture.payload;

  switch (fixture.id) {
    case "session-intent-canonical": {
      const value = payload as {
        readonly path: string;
        readonly expected_absent: unknown;
        readonly ignored_legacy_paths: readonly string[];
      };
      expect(value.path).toBe(
        matrix.approved_defaults.session_intent.canonical_path,
      );
      expect(value.expected_absent).toEqual(
        matrix.approved_defaults.session_intent.absent_result,
      );
      expect(value.ignored_legacy_paths).not.toContain(value.path);
      break;
    }
    case "task-affinity-permutation": {
      const value = payload as {
        readonly input: { readonly task_ids: readonly string[] };
        readonly expected: { readonly task_ids: readonly string[] };
      };
      expect(value.input.task_ids).toEqual(["task-b", "task-a"]);
      expect(value.expected.task_ids).toEqual(["task-a", "task-b"]);
      break;
    }
    case "coherence-golden-topology": {
      const value = payload as { readonly expected: unknown };
      expect(value.expected).toEqual(matrix.coherence_policy.golden_trace);
      break;
    }
    case "backend-independent-plan": {
      const value = payload as {
        readonly groups: readonly {
          readonly finding_ids: readonly string[];
          readonly token_estimate: number;
        }[];
        readonly coverage: readonly { readonly finding_id: string }[];
      };
      expect(
        sortedUnique(value.groups.flatMap((group) => group.finding_ids)),
      ).toEqual(
        sortedUnique(value.coverage.map((entry) => entry.finding_id)),
      );
      expect(
        value.groups.every((group) => Number.isInteger(group.token_estimate)),
      ).toBe(true);
      break;
    }
    case "audit-host-workload": {
      const value = payload as {
        readonly work_items: readonly {
          readonly id: string;
          readonly prompt: { readonly sha256: string };
        }[];
      };
      expect(value.work_items).toHaveLength(1);
      expect(value.work_items[0]?.id).toBe("audit-task-001");
      break;
    }
    case "audit-untrusted-result": {
      const value = payload as {
        readonly work_item_id: string;
        readonly prompt_sha256: string;
      };
      const workload = workloads.fixtures.find(
        (candidate) => candidate.id === "audit-host-workload",
      )?.payload as {
        readonly work_items: readonly {
          readonly id: string;
          readonly prompt: { readonly sha256: string };
        }[];
      };
      expect(value.work_item_id).toBe(workload.work_items[0]?.id);
      expect(value.prompt_sha256).toBe(
        workload.work_items[0]?.prompt.sha256,
      );
      break;
    }
    case "remediation-host-workload": {
      const value = payload as {
        readonly work_items: readonly {
          readonly id: string;
          readonly required_tests: readonly string[];
        }[];
      };
      expect(value.work_items[0]?.id).toBe("remediation-item-001");
      expect(value.work_items[0]?.required_tests).toHaveLength(1);
      break;
    }
    case "remediation-host-result": {
      const value = payload as {
        readonly work_item_id: string;
        readonly prompt_sha256: string;
        readonly commit_evidence: { readonly before: string };
        readonly test_evidence: readonly { readonly command: string }[];
      };
      const workload = workloads.fixtures.find(
        (candidate) => candidate.id === "remediation-host-workload",
      )?.payload as {
        readonly work_items: readonly {
          readonly id: string;
          readonly baseline_commit: string;
          readonly prompt: { readonly sha256: string };
          readonly required_tests: readonly string[];
        }[];
      };
      const item = workload.work_items[0];
      expect(value.work_item_id).toBe(item?.id);
      expect(value.prompt_sha256).toBe(item?.prompt.sha256);
      expect(value.commit_evidence.before).toBe(item?.baseline_commit);
      expect(value.test_evidence[0]?.command).toBe(item?.required_tests[0]);
      break;
    }
    case "attribution-free-result": {
      const value = payload as { readonly outcome: string };
      expect(value.outcome).toBe("accepted");
      break;
    }
    default:
      throw new Error("unhandled provider-neutral fixture " + fixture.id);
  }

  expect(Object.values(spies.counts).every((count) => count === 0)).toBe(true);
  return fixture.positive_event;
}

test("provider-neutral fixtures cover all seven modules with fail-on-call local spies", () => {
  expect(workloads.contract_version).toBe(
    "zero-adapter-provider-neutral-fixtures/v1",
  );
  expect(workloads.spy_contract.mode).toBe("throw-on-call");
  expect(workloads.spy_contract.required_call_count).toBe(0);
  expect(workloads.spy_contract.forbidden_actions.map((action) => action.id)).toEqual([
    "backend_window_lookup",
    "legacy_config_probe",
    "network_access",
    "provider_launch",
    "provider_resolution",
    "quota_admission",
  ]);

  const covered = sortedUnique(
    workloads.fixtures.flatMap((fixture) => fixture.contract_ids),
  );
  expect(covered).toEqual(PRODUCTION_MODULE_IDS);

  const allFixtureIds = workloads.fixtures.map((fixture) => fixture.id);
  const referenced = matrix.contracts.flatMap((contract) => contract.fixture_ids);
  expect(sortedUnique(allFixtureIds)).toEqual(sortedUnique(referenced));

  for (const action of workloads.spy_contract.forbidden_actions) {
    const spies = createForbiddenSpies();
    expect(() => spies.calls[action.id]?.()).toThrow(action.error_code);
    expect(spies.counts[action.id]).toBe(1);
  }

  for (const fixture of workloads.fixtures) {
    const coupledKeys = collectObjectKeys(fixture.payload).filter(({ key }) => {
      const normalized = key.toLowerCase();
      return workloads.forbidden_payload_key_fragments.some((fragment) =>
        normalized.includes(fragment),
      );
    });
    expect(coupledKeys, fixture.id + " has execution-coupled payload keys").toEqual([]);

    const spies = createForbiddenSpies();
    expect(replayPositiveFixture(fixture, spies)).toBe(fixture.positive_event);
    expect(Object.values(spies.counts)).toEqual(
      expect.arrayContaining(
        workloads.spy_contract.forbidden_actions.map(() => 0),
      ),
    );
  }
});

test("the importable offline harness replays every fixture through its consumer-shaped seam", () => {
  for (const fixture of workloads.fixtures) {
    const harness = createOfflineFailOnCallHarness(
      workloads.spy_contract.forbidden_actions,
    );
    const result = replayProviderNeutralFixture(
      fixture as ProviderNeutralFixture,
      workloads.fixtures as readonly ProviderNeutralFixture[],
      harness,
    );
    expect(result.positive_event).toBe(fixture.positive_event);
    expect(result.consumer_seam.length).toBeGreaterThan(0);
    expect(result.replacement_output).toBeDefined();
    expect(Object.values(result.action_counts)).toEqual(
      workloads.spy_contract.forbidden_actions.map(() => 0),
    );
    expect(() => harness.assertUntouched()).not.toThrow();
  }

  for (const action of workloads.spy_contract.forbidden_actions) {
    const harness = createOfflineFailOnCallHarness(
      workloads.spy_contract.forbidden_actions,
    );
    expect(() => harness.calls[action.id]?.()).toThrow(action.error_code);
    expect(() => harness.assertUntouched()).toThrow(
      "offline action invoked: " + action.id + "=1",
    );
  }
});

const EXPECTED_BASELINE_PATHS = [
  ".audit-tools/nightly/open-items.json",
  ".audit-tools/nightly/proposals/LEADS-audit-pkg-doc-drift-2026-08-10/ADVERSARY-2026-08-11.md",
  ".audit-tools/nightly/proposals/P21-peer-cli-dispatch-piped-into-buffering-filter/PROPOSAL.md",
  ".audit-tools/nightly/proposals/P21-peer-cli-dispatch-piped-into-buffering-filter/patch.md",
  ".audit-tools/remediation-outcomes.json",
  ".audit-tools/remediation-report.md",
  ".claude/hooks/closeout-challenge-gate.mjs",
  ".claude/hooks/pre-commit-gate.mjs",
  "CLAUDE.md",
  "docs/HANDOFF.md",
  "docs/nightly-inbox.md",
  "scripts/guard-reach-data.mjs",
  "scripts/nightly/items.mjs",
  "scripts/shared/generate-handoff-roadmap.mjs",
  "tests/shared/handoff-roadmap.test.ts",
  "tests/shared/nightly-completion-ledger.test.ts",
  "tests/shared/nightly-routine.test.ts",
] as const;

const FOUNDATION_WRITE_ONCE_ORACLE: WriteOnceGateOracle = {
  gate_manifest_sha256:
    "e5c9215e1b86d772fc3441f683a83b0244f005b3afe4224d8814d5d31b826f4b",
  pre_edit_test_tree_sha256:
    "3af6651f8860c21fd14ef1013a9142c87bc854de3f49bbfaf8def271acd88c44",
  head_tests_tree_oid: "567bc1dfe3d70561d0888723d8ba9e234b0330a6",
  sealed_overlap_manifest_sha256:
    "30aaf9b42650df973bf4edd2b54e0e6a8981bd5287b1d27ca3bed3f7771c37a9",
  foundation_owned_paths: [
    "tests/shared/fixtures/remediation-contracts/contract-harness.ts",
    "tests/shared/fixtures/remediation-contracts/contract-matrix.json",
    "tests/shared/fixtures/remediation-contracts/dependency-manifest.json",
    "tests/shared/fixtures/remediation-contracts/dirty-worktree-baseline.json",
    "tests/shared/fixtures/remediation-contracts/owned-overlap-remediation-contract-tests.json",
    "tests/shared/fixtures/remediation-contracts/provider-neutral-workloads.json",
    "tests/shared/fixtures/remediation-contracts/red-run-evidence.json",
    "tests/shared/fixtures/remediation-contracts/write-once-gate-remediation-contract-tests.json",
    "tests/shared/remediation-contracts.test.ts",
  ],
};

test("the pre-edit dirty baseline is complete, binary-safe, content-addressed, and truthfully dirty", () => {
  expectExactKeys(
    baseline,
    [
      "baseline_id",
      "capture_boundary",
      "captured_branch",
      "captured_head",
      "contract_version",
      "hash_algorithm",
      "hunk_identity_format",
      "immutable",
      "manifest_sha256",
      "patch_digest_format",
      "path_count",
      "status_entries",
      "status_format",
      "status_snapshot_sha256",
      "worktree_was_clean",
    ],
    "dirty baseline fields",
  );
  expect(baseline.contract_version).toBe(
    "zero-adapter-dirty-worktree-baseline/v1",
  );
  expect(baseline.captured_branch).toBe(
    "codex/fix-remaining-audit-findings",
  );
  expect(baseline.captured_head).toBe(
    "3f123b9b4be813d39d7f45197c23628745c7b8ba",
  );
  expect(baseline.path_count).toBe(17);
  expect(baseline.worktree_was_clean).toBe(false);
  expect(baseline.status_entries.map((entry) => entry.path)).toEqual(
    EXPECTED_BASELINE_PATHS,
  );
  expect(
    baseline.status_entries.filter((entry) => entry.status === " M"),
  ).toHaveLength(14);
  expect(
    baseline.status_entries.filter((entry) => entry.status === "??"),
  ).toHaveLength(3);

  const baselineRecord = baseline as unknown as Readonly<Record<string, unknown>>;
  expect(
    sha256(stableStringify(withoutKey(baselineRecord, "manifest_sha256"))),
  ).toBe(baseline.manifest_sha256);
  expect(baseline.manifest_sha256).toBe(
    "9263dc78f042cbd2d4aefaf3e0cad68ce78223cf3217fd31d5fa8f552480eb68",
  );

  const shaPattern = /^[0-9a-f]{64}$/u;
  const hunkIds = new Set<string>();
  for (const entry of baseline.status_entries) {
    expectExactKeys(
      entry,
      [
        "binary_patch_sha256",
        "head_bytes",
        "head_sha256",
        "hunks",
        "index_bytes",
        "index_sha256",
        "original_path",
        "path",
        "status",
        "worktree_bytes",
        "worktree_sha256",
      ],
      "dirty entry " + entry.path,
    );
    expect(entry.binary_patch_sha256).toMatch(shaPattern);
    expect(entry.worktree_sha256).toMatch(shaPattern);
    expect(entry.worktree_bytes).toBeGreaterThan(0);
    expect(entry.hunks.length).toBeGreaterThan(0);

    if (entry.status === "??") {
      expect(entry.head_sha256).toBeNull();
      expect(entry.index_sha256).toBeNull();
      expect(entry.head_bytes).toBeNull();
      expect(entry.index_bytes).toBeNull();
    } else {
      expect(entry.status).toBe(" M");
      expect(entry.head_sha256).toMatch(shaPattern);
      expect(entry.index_sha256).toBe(entry.head_sha256);
      expect(entry.head_bytes).toBe(entry.index_bytes);
      expect(entry.worktree_sha256).not.toBe(entry.index_sha256);
    }

    for (const hunk of entry.hunks) {
      expectExactKeys(
        hunk,
        ["header", "hunk_id", "patch_sha256", "source"],
        "hunk " + hunk.hunk_id,
      );
      expect(hunk.patch_sha256).toMatch(shaPattern);
      expect(hunk.hunk_id.endsWith(hunk.patch_sha256)).toBe(true);
      expect(hunkIds.has(hunk.hunk_id)).toBe(false);
      hunkIds.add(hunk.hunk_id);
    }
  }
});

test("the foundation overlap authorization is immutable, bound to the baseline, and explicitly empty", () => {
  expect(overlap).toMatchObject({
    contract_version: "zero-adapter-owned-overlap/v1",
    module_id: "remediation-contract-tests",
    baseline_id: baseline.baseline_id,
    baseline_manifest_sha256: baseline.manifest_sha256,
    capture_boundary: "before-remediation-contract-tests-first-test-edit",
    immutable: true,
    finalized: true,
    explicitly_empty: true,
    owned_overlaps: [],
  });

  const overlapRecord = overlap as unknown as Readonly<Record<string, unknown>>;
  expect(
    sha256(stableStringify(withoutKey(overlapRecord, "manifest_sha256"))),
  ).toBe(overlap.manifest_sha256);
  expect(overlap.manifest_sha256).toBe(
    "30aaf9b42650df973bf4edd2b54e0e6a8981bd5287b1d27ca3bed3f7771c37a9",
  );

  const frozen = deepFreeze(structuredClone(overlap));
  expect(() => (frozen.owned_overlaps as unknown[]).push({})).toThrow();
});

test("the independently sealed write-once gate rejects overlap expansion and late creation", () => {
  expect(
    validateWriteOnceGate(
      writeOnceGate,
      overlap,
      baseline,
      FOUNDATION_WRITE_ONCE_ORACLE,
    ),
  ).toEqual([]);

  const expandedOverlap = structuredClone(overlap) as OwnedOverlap & {
    owned_overlaps: unknown[];
    manifest_sha256: string;
  };
  expandedOverlap.owned_overlaps.push({
    path: "tests/shared/handoff-roadmap.test.ts",
    owner: "late-owner",
  });
  expandedOverlap.manifest_sha256 = harnessCanonicalSha256(
    withoutKey(
      expandedOverlap as unknown as Readonly<Record<string, unknown>>,
      "manifest_sha256",
    ),
  );
  expect(
    validateWriteOnceGate(
      writeOnceGate,
      expandedOverlap,
      baseline,
      FOUNDATION_WRITE_ONCE_ORACLE,
    ),
  ).toEqual(
    expect.arrayContaining([
      "write-once:overlap-contract",
      "write-once:overlap-expanded-or-replaced",
    ]),
  );

  const lateGate = structuredClone(writeOnceGate);
  const lateTree = lateGate.pre_edit_test_tree as Record<string, unknown>;
  lateTree.untracked_test_paths = [
    "tests/shared/remediation-contracts.test.ts",
  ];
  lateTree.tree_sha256 = harnessCanonicalSha256(
    withoutKey(lateTree, "tree_sha256"),
  );
  lateGate.gate_manifest_sha256 = harnessCanonicalSha256(
    withoutKey(lateGate, "gate_manifest_sha256"),
  );
  expect(
    validateWriteOnceGate(
      lateGate,
      overlap,
      baseline,
      FOUNDATION_WRITE_ONCE_ORACLE,
    ),
  ).toEqual(
    expect.arrayContaining([
      "write-once:independent-gate-seal",
      "write-once:independent-test-tree-seal",
      "write-once:untracked-test-paths",
    ]),
  );

  const expandedGate = structuredClone(writeOnceGate);
  expandedGate.foundation_owned_paths_absent = [
    ...(expandedGate.foundation_owned_paths_absent as string[]),
    "tests/shared/late-foundation-file.test.ts",
  ];
  expandedGate.gate_manifest_sha256 = harnessCanonicalSha256(
    withoutKey(expandedGate, "gate_manifest_sha256"),
  );
  expect(
    validateWriteOnceGate(
      expandedGate,
      overlap,
      baseline,
      FOUNDATION_WRITE_ONCE_ORACLE,
    ),
  ).toEqual(
    expect.arrayContaining([
      "write-once:foundation-path-oracle",
      "write-once:independent-gate-seal",
    ]),
  );
});

interface EvidenceSamples {
  readonly red: Record<string, unknown>;
  readonly green: Record<string, unknown>;
  readonly material: EvidenceBundleMaterial;
}

function productionScope(
  files: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const entries = Object.entries(files)
    .map(([path, content]) => ({ path, sha256: sha256Bytes(content) }))
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return { entries, tree_sha256: treeSha256(entries) };
}

function schemaOnlyEvidenceSamples(): EvidenceSamples {
  const closureFiles: Readonly<Record<string, string>> = {
    "node_modules/vitest/vitest.mjs": "runner-entrypoint",
    "package-lock.json": "lockfile",
    "tests/schema-only.test.ts": "designated-test",
    "vitest.config.ts": "test-config",
  };
  const closureBase: Record<string, unknown> = {
    files: [
      {
        path: "node_modules/vitest/vitest.mjs",
        role: "runner_entrypoint",
        sha256: sha256Bytes(closureFiles["node_modules/vitest/vitest.mjs"] ?? ""),
      },
      {
        path: "package-lock.json",
        role: "lockfile",
        sha256: sha256Bytes(closureFiles["package-lock.json"] ?? ""),
      },
      {
        path: "tests/schema-only.test.ts",
        role: "designated_test",
        sha256: sha256Bytes(closureFiles["tests/schema-only.test.ts"] ?? ""),
      },
      {
        path: "vitest.config.ts",
        role: "test_config",
        sha256: sha256Bytes(closureFiles["vitest.config.ts"] ?? ""),
      },
    ],
    runner: {
      entrypoint_sha256: sha256Bytes(
        closureFiles["node_modules/vitest/vitest.mjs"] ?? "",
      ),
      name: "vitest",
      version: "3.2.6",
    },
    test_id: "schema-conformance-only",
  };
  const closure: Record<string, unknown> = {
    ...closureBase,
    closure_sha256: closureSha256(closureBase),
  };
  const command = {
    argv: ["npx", "vitest", "run", "tests/schema-only.test.ts"],
    cwd: ".",
    normalized_environment: { CI: "1", NO_COLOR: "1", TZ: "UTC" },
  };
  const assignment = {
    module_id: "schema-conformance-only",
    test_id: "schema-conformance-only",
    command,
    expected_red_failure_signature:
      "contract:schema-only:not-yet-satisfied",
  };
  const discoveredClosurePaths = Object.keys(closureFiles).sort(compareCodeUnits);
  const redOutput = {
    stdout: "contract:schema-only:not-yet-satisfied\n",
    stderr: "assertion failed\n",
  };
  const greenOutput = { stdout: "schema contract passed\n", stderr: "" };
  const redProduction = { "src/schema-only.ts": "before-production-bytes" };
  const greenProduction = { "src/schema-only.ts": "after-production-bytes" };

  const redBase: Record<string, unknown> = {
    command,
    contract_version: evidence.red_record_schema.contract_version,
    exit_code: 1,
    expected_failure_signature: "contract:schema-only:not-yet-satisfied",
    module_id: "schema-conformance-only",
    output_sha256: outputSha256(redOutput),
    pre_edit_production_scope: productionScope(redProduction),
    test_closure: closure,
    test_id: "schema-conformance-only",
  };
  const red: Record<string, unknown> = {
    ...redBase,
    record_sha256: recordSha256(redBase),
  };
  const greenBase: Record<string, unknown> = {
    command: structuredClone(command),
    contract_version: evidence.green_companion_schema.contract_version,
    exit_code: 0,
    module_id: "schema-conformance-only",
    output_sha256: outputSha256(greenOutput),
    post_edit_production_scope: productionScope(greenProduction),
    red_record_sha256: red.record_sha256,
    test_closure_sha256: closure.closure_sha256,
    test_id: "schema-conformance-only",
  };
  const green: Record<string, unknown> = {
    ...greenBase,
    record_sha256: recordSha256(greenBase),
  };
  return {
    red,
    green,
    material: {
      red: {
        output: redOutput,
        assignment,
        discovered_closure_paths: discoveredClosurePaths,
        closure_files: closureFiles,
        production_files: redProduction,
      },
      green: {
        output: greenOutput,
        assignment,
        discovered_closure_paths: discoveredClosurePaths,
        closure_files: closureFiles,
        production_files: greenProduction,
      },
    },
  };
}

test("the finalized v1 evidence artifact is schema-only and the importable validator recomputes every hash", () => {
  expect(evidence.contract_version).toBe(
    "zero-adapter-red-green-evidence-contract/v1",
  );
  expect(evidence.schema_status).toBe("finalized");
  expect(evidence.immutable).toBe(true);
  expect(evidence.production_red_claims).toEqual([]);
  expect(evidence.red_records).toEqual([]);
  expect(evidence.green_companions).toEqual([]);

  const samples = schemaOnlyEvidenceSamples();
  expect(
    validateRedEvidenceRecord(evidence, samples.red, samples.material.red),
  ).toEqual([]);
  expect(
    validateGreenEvidenceRecord(evidence, samples.green, samples.material.green),
  ).toEqual([]);
  expect(
    validateRedGreenEvidenceBundle(
      evidence,
      samples.red,
      samples.green,
      samples.material,
    ),
  ).toEqual([]);
});

test("every top-level and nested evidence-schema field is mechanically required", () => {
  const samples = schemaOnlyEvidenceSamples();

  for (const key of evidence.red_record_schema.required_keys) {
    expect(
      validateRedEvidenceRecord(
        evidence,
        withoutKey(samples.red, key),
        samples.material.red,
      ),
    ).toContain("red:missing:" + key);
  }
  for (const key of evidence.green_companion_schema.required_keys) {
    expect(
      validateGreenEvidenceRecord(
        evidence,
        withoutKey(samples.green, key),
        samples.material.green,
      ),
    ).toContain("green:missing:" + key);
  }

  for (const key of evidence.command_schema.required_keys) {
    const mutated = structuredClone(samples.red);
    mutated.command = withoutKey(
      mutated.command as Readonly<Record<string, unknown>>,
      key,
    );
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.command:missing:" + key);
  }

  for (const key of evidence.test_closure_schema.required_keys) {
    const mutated = structuredClone(samples.red);
    mutated.test_closure = withoutKey(
      mutated.test_closure as Readonly<Record<string, unknown>>,
      key,
    );
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.test_closure:missing:" + key);
  }

  const closure = samples.red.test_closure as Readonly<Record<string, unknown>>;
  for (const key of evidence.test_closure_schema.runner_required_keys) {
    const mutated = structuredClone(samples.red);
    const mutatedClosure = mutated.test_closure as Record<string, unknown>;
    mutatedClosure.runner = withoutKey(
      mutatedClosure.runner as Readonly<Record<string, unknown>>,
      key,
    );
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.test_closure.runner:missing:" + key);
  }

  const files = closure.files as readonly Readonly<Record<string, unknown>>[];
  const firstFile = files[0];
  if (!firstFile) throw new Error("schema closure requires a file");
  for (const key of evidence.test_closure_schema.file_entry_required_keys) {
    const mutated = structuredClone(samples.red);
    const mutatedClosure = mutated.test_closure as Record<string, unknown>;
    const mutatedFiles = mutatedClosure.files as Record<string, unknown>[];
    const firstMutatedFile = mutatedFiles[0];
    if (!firstMutatedFile) throw new Error("schema closure requires a file");
    mutatedFiles[0] = withoutKey(firstMutatedFile, key);
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.test_closure.files[0]:missing:" + key);
  }

  for (const key of evidence.production_scope_schema.required_keys) {
    const mutated = structuredClone(samples.red);
    mutated.pre_edit_production_scope = withoutKey(
      mutated.pre_edit_production_scope as Readonly<Record<string, unknown>>,
      key,
    );
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.pre_edit_production_scope:missing:" + key);
  }

  const scope = samples.red.pre_edit_production_scope as Readonly<
    Record<string, unknown>
  >;
  const entries = scope.entries as readonly Readonly<Record<string, unknown>>[];
  const firstEntry = entries[0];
  if (!firstEntry) throw new Error("schema scope requires an entry");
  for (const key of evidence.production_scope_schema.entry_required_keys) {
    const mutated = structuredClone(samples.red);
    const mutatedScope = mutated.pre_edit_production_scope as Record<
      string,
      unknown
    >;
    const mutatedEntries = mutatedScope.entries as Record<string, unknown>[];
    const firstMutatedEntry = mutatedEntries[0];
    if (!firstMutatedEntry) throw new Error("schema scope requires an entry");
    mutatedEntries[0] = withoutKey(firstMutatedEntry, key);
    expect(
      validateRedEvidenceRecord(evidence, mutated, samples.material.red),
    ).toContain("red.pre_edit_production_scope.entries[0]:missing:" + key);
  }
});

test("fake 64-character digests and incomplete closure roles cannot satisfy evidence", () => {
  const samples = schemaOnlyEvidenceSamples();
  const fakeDigest = "f".repeat(64);

  expect(
    validateRedEvidenceRecord(
      evidence,
      { ...samples.red, record_sha256: fakeDigest },
      samples.material.red,
    ),
  ).toContain("red:record-sha256-mismatch");
  expect(
    validateRedEvidenceRecord(
      evidence,
      { ...samples.red, output_sha256: fakeDigest },
      samples.material.red,
    ),
  ).toContain("red:output-sha256-mismatch");

  const fakeClosure = structuredClone(samples.red);
  (fakeClosure.test_closure as Record<string, unknown>).closure_sha256 =
    fakeDigest;
  expect(
    validateRedEvidenceRecord(evidence, fakeClosure, samples.material.red),
  ).toContain("red.test_closure:closure-sha256-mismatch");

  const fakeTree = structuredClone(samples.red);
  (
    fakeTree.pre_edit_production_scope as Record<string, unknown>
  ).tree_sha256 = fakeDigest;
  expect(
    validateRedEvidenceRecord(evidence, fakeTree, samples.material.red),
  ).toContain("red.pre_edit_production_scope:tree-sha256-mismatch");

  const changedClosureContent = structuredClone(samples.material);
  (
    changedClosureContent.red.closure_files as Record<string, string>
  )["tests/schema-only.test.ts"] = "changed-test-bytes";
  expect(
    validateRedEvidenceRecord(evidence, samples.red, changedClosureContent.red),
  ).toContain("red.test_closure.files[2]:content-sha256-mismatch");

  const changedProductionContent = structuredClone(samples.material);
  (
    changedProductionContent.red.production_files as Record<string, string>
  )["src/schema-only.ts"] = "changed-production-bytes";
  expect(
    validateRedEvidenceRecord(
      evidence,
      samples.red,
      changedProductionContent.red,
    ),
  ).toContain(
    "red.pre_edit_production_scope.entries[0]:content-sha256-mismatch",
  );

  for (const role of evidence.test_closure_schema.required_file_roles) {
    const missingRole = structuredClone(samples.red);
    const missingRoleClosure = missingRole.test_closure as Record<string, unknown>;
    missingRoleClosure.files = (
      missingRoleClosure.files as Record<string, unknown>[]
    ).filter((entry) => entry.role !== role);
    expect(
      validateRedEvidenceRecord(evidence, missingRole, samples.material.red),
    ).toContain("red.test_closure:required-role-count:" + role);
  }

  expect(
    validateRedEvidenceRecord(
      evidence,
      {
        ...samples.red,
        expected_failure_signature: "not-present-in-output",
      },
      samples.material.red,
    ),
  ).toContain("red:output-contains-expected-failure-signature");

  expect(
    validateGreenEvidenceRecord(
      evidence,
      { ...samples.green, fabricated: true },
      samples.material.green,
    ),
  ).toContain("green:unexpected:fabricated");

  expect(
    validateGreenEvidenceRecord(
      evidence,
      { ...samples.green, output_sha256: fakeDigest },
      samples.material.green,
    ),
  ).toContain("green:output-sha256-mismatch");
  expect(
    validateGreenEvidenceRecord(
      evidence,
      { ...samples.green, record_sha256: fakeDigest },
      samples.material.green,
    ),
  ).toContain("green:record-sha256-mismatch");

  const omittedMaterialFile = structuredClone(samples.red);
  const omittedClosure = omittedMaterialFile.test_closure as Record<
    string,
    unknown
  >;
  omittedClosure.files = (
    omittedClosure.files as Record<string, unknown>[]
  ).filter((entry) => entry.path !== "vitest.config.ts");
  omittedClosure.closure_sha256 = closureSha256(omittedClosure);
  expect(
    validateRedEvidenceRecord(
      evidence,
      omittedMaterialFile,
      samples.material.red,
    ),
  ).toContain("red.test_closure:closure-path-set-mismatch");
});

test("evidence is bound to the exact matrix assignment", () => {
  const samples = schemaOnlyEvidenceSamples();
  expect(
    validateRedEvidenceRecord(
      evidence,
      { ...samples.red, module_id: "another-module" },
      samples.material.red,
    ),
  ).toContain("red:matrix-module-id-mismatch");
  expect(
    validateRedEvidenceRecord(
      evidence,
      { ...samples.red, test_id: "another-test" },
      samples.material.red,
    ),
  ).toContain("red:matrix-test-id-mismatch");
  expect(
    validateRedEvidenceRecord(
      evidence,
      {
        ...samples.red,
        command: {
          ...(samples.red.command as Record<string, unknown>),
          argv: ["npx", "vitest", "run", "tests/other.test.ts"],
        },
      },
      samples.material.red,
    ),
  ).toContain("red:matrix-command-mismatch");
  expect(
    validateRedEvidenceRecord(
      evidence,
      {
        ...samples.red,
        expected_failure_signature: "contract:other:not-yet-satisfied",
      },
      samples.material.red,
    ),
  ).toContain("red:matrix-failure-signature-mismatch");
  expect(
    validateGreenEvidenceRecord(
      evidence,
      { ...samples.green, module_id: "another-module" },
      samples.material.green,
    ),
  ).toContain("green:matrix-module-id-mismatch");
});

test("every finalized red/green invariant has an executable negative case", () => {
  const cases: Readonly<
    Record<
      string,
      {
        readonly expected: string;
        readonly mutate: (samples: EvidenceSamples) => EvidenceSamples;
      }
    >
  > = {
    "same-module-id": {
      expected: "pair:same-module-id",
      mutate: (samples) => ({
        ...samples,
        green: { ...samples.green, module_id: "changed-module" },
      }),
    },
    "same-test-id": {
      expected: "pair:same-test-id",
      mutate: (samples) => ({
        ...samples,
        green: { ...samples.green, test_id: "changed-test" },
      }),
    },
    "identical-argv": {
      expected: "pair:identical-argv",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (changed.green.command as Record<string, unknown>).argv = ["changed"];
        return changed;
      },
    },
    "identical-cwd": {
      expected: "pair:identical-cwd",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (changed.green.command as Record<string, unknown>).cwd = "elsewhere";
        return changed;
      },
    },
    "identical-normalized-environment": {
      expected: "pair:identical-normalized-environment",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (
          changed.green.command as Record<string, unknown>
        ).normalized_environment = { CI: "0" };
        return changed;
      },
    },
    "identical-test-closure-sha256": {
      expected: "pair:identical-test-closure-sha256",
      mutate: (samples) => ({
        ...samples,
        green: { ...samples.green, test_closure_sha256: "f".repeat(64) },
      }),
    },
    "green-references-red-record-sha256": {
      expected: "pair:green-references-red-record-sha256",
      mutate: (samples) => ({
        ...samples,
        green: { ...samples.green, red_record_sha256: "f".repeat(64) },
      }),
    },
    "red-pre-edit-production-tree-digest-recomputes": {
      expected: "red.pre_edit_production_scope:tree-sha256-mismatch",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (
          changed.red.pre_edit_production_scope as Record<string, unknown>
        ).tree_sha256 = "f".repeat(64);
        return changed;
      },
    },
    "green-post-edit-production-tree-digest-recomputes": {
      expected: "green.post_edit_production_scope:tree-sha256-mismatch",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (
          changed.green.post_edit_production_scope as Record<string, unknown>
        ).tree_sha256 = "f".repeat(64);
        return changed;
      },
    },
    "red-exit-code-is-nonzero": {
      expected: "red:exit-code-is-nonzero",
      mutate: (samples) => ({
        ...samples,
        red: { ...samples.red, exit_code: 0 },
      }),
    },
    "red-output-contains-expected-failure-signature": {
      expected: "red:output-contains-expected-failure-signature",
      mutate: (samples) => ({
        ...samples,
        red: {
          ...samples.red,
          expected_failure_signature: "missing-signature",
        },
      }),
    },
    "green-exit-code-is-zero": {
      expected: "green:exit-code-is-zero",
      mutate: (samples) => ({
        ...samples,
        green: { ...samples.green, exit_code: 2 },
      }),
    },
    "red-and-green-output-digests-recompute": {
      expected: "red:output-sha256-mismatch",
      mutate: (samples) => ({
        ...samples,
        red: { ...samples.red, output_sha256: "f".repeat(64) },
      }),
    },
    "red-and-green-record-content-hashes-recompute": {
      expected: "red:record-sha256-mismatch",
      mutate: (samples) => ({
        ...samples,
        red: { ...samples.red, record_sha256: "f".repeat(64) },
      }),
    },
    "red-record-and-test-closure-are-read-only-after-production-mutation": {
      expected:
        "pair:red-record-and-test-closure-are-read-only-after-production-mutation",
      mutate: (samples) => {
        const changed = structuredClone(samples);
        (
          changed.material.green.closure_files as Record<string, string>
        )["tests/schema-only.test.ts"] = "post-red-test-mutation";
        return changed;
      },
    },
  };

  expect(Object.keys(cases)).toEqual(evidence.cross_record_invariants);
  for (const invariant of evidence.cross_record_invariants) {
    const scenario = cases[invariant];
    if (!scenario) throw new Error("missing negative case for " + invariant);
    const changed = scenario.mutate(schemaOnlyEvidenceSamples());
    expect(
      validateRedGreenEvidenceBundle(
        evidence,
        changed.red,
        changed.green,
        changed.material,
      ),
      invariant,
    ).toContain(scenario.expected);
  }
});

test("artifact fixtures remain immutable under attempted in-memory mutation", () => {
  const frozenMatrix = deepFreeze(structuredClone(matrix));
  expect(() =>
    (frozenMatrix.contracts[0]?.required_guarantees as string[]).push("drift"),
  ).toThrow();

  const frozenEvidence = deepFreeze(structuredClone(evidence));
  expect(() =>
    (frozenEvidence.production_red_claims as unknown[]).push({
      forbidden: "synthetic-production-claim",
    }),
  ).toThrow();

  expect(JSON.parse(matrixArtifact.raw)).toEqual(matrix);
  expect(JSON.parse(dependencyArtifact.raw)).toEqual(dependencyManifest);
  expect(JSON.parse(workloadArtifact.raw)).toEqual(workloads);
  expect(JSON.parse(baselineArtifact.raw)).toEqual(baseline);
  expect(JSON.parse(overlapArtifact.raw)).toEqual(overlap);
  expect(JSON.parse(evidenceArtifact.raw)).toEqual(evidence);
});
