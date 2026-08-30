import { describe, it, expect } from "vitest";
import { ARTIFACT_DEFINITIONS } from "../../src/audit/io/artifacts.js";
import {
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
} from "../../src/shared/io/auditToolsPaths.js";
import { RUNTIME_ARTIFACT_NAMES } from "../../scripts/shared/runtime-artifact-names.generated.mjs";

/**
 * Drift pin for the generated run-artifact name set the doc-citation gate
 * consumes. The gate runs under plain node pre-build, so it imports the
 * generated `.mjs` sibling instead of the TypeScript registries — this test is
 * what keeps that sibling honest: it re-runs the extraction against the live
 * sources AND cross-checks the one true registry (`ARTIFACT_DEFINITIONS`)
 * directly, so a renamed artifact fails here instead of surfacing as a false
 * red (or a silently exempt citation) in the doc gate.
 */
describe("runtime-artifact-names.generated.mjs — drift against the layout sources", () => {
  it("every ARTIFACT_DEFINITIONS filename and deliverable name is in the set", () => {
    const names = new Set<string>(RUNTIME_ARTIFACT_NAMES);
    for (const [key, definition] of Object.entries(ARTIFACT_DEFINITIONS)) {
      expect(names.has(definition.fileName), `${key} → ${definition.fileName}`).toBe(true);
    }
    for (const deliverable of [
      AUDIT_REPORT_FILENAME,
      AUDIT_FINDINGS_FILENAME,
      REMEDIATION_REPORT_FILENAME,
      REMEDIATION_OUTCOMES_FILENAME,
    ]) {
      expect(names.has(deliverable), deliverable).toBe(true);
    }
  });

  it("the set is sorted, deduped, and free of suffix-test artifacts", () => {
    const names = [...RUNTIME_ARTIFACT_NAMES];
    expect(names).toEqual([...new Set(names)].sort());
    for (const name of names) {
      expect(name.startsWith("."), `leading-dot entry ${name}`).toBe(false);
      expect(name.includes("/"), `slashed entry ${name}`).toBe(false);
    }
  });
});
