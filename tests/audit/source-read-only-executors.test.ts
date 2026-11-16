/**
 * The source-read-only allowlist, pinned by id.
 *
 * `preservesSourceIndexes` lets a runner keep the fold's manifest-index memo.
 * The flag lives on each `EXECUTOR_REGISTRY` row (`source_read_only`), and the
 * default is false: a new runner, and every command-backed runner, drops the
 * memo. This test holds the exact set, so moving the declaration cannot add or
 * lose a member without a red test.
 */
import { describe, expect, it } from "vitest";

import { preservesSourceIndexes } from "../../src/audit/orchestrator/executorRunners.js";
import { EXECUTOR_REGISTRY } from "../../src/audit/orchestrator/executors.js";

const SOURCE_READ_ONLY = [
  "critical_flow_fallback_executor",
  "design_assessment_executor",
  "docs_digest_executor",
  "external_analyzer_import_executor",
  "intent_equivalence_executor",
  "result_ingestion_executor",
  "runtime_validation_update_executor",
  "structure_decomposition_executor",
];

describe("preservesSourceIndexes", () => {
  it("is true for exactly the audited source-read-only executors", () => {
    const preserved = EXECUTOR_REGISTRY.map((executor) => executor.id)
      .filter((id) => preservesSourceIndexes(id))
      .sort();
    expect(preserved).toEqual(SOURCE_READ_ONLY);
  });

  it("is false for no executor and for an unknown id", () => {
    expect(preservesSourceIndexes(null)).toBe(false);
    expect(preservesSourceIndexes("not_a_registered_executor")).toBe(false);
  });
});
