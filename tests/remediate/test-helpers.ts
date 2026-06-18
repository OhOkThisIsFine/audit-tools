import type { Finding } from "audit-tools/shared";
import type { RemediationState } from '../../src/remediate/state/store.js';
import type { ItemSpec } from "../../src/remediate/state/types.js";

export function makeState(overrides: Record<string, unknown> = {}): RemediationState {
  return {
    status: 'pending',
    plan: {
      plan_id: 'P1',
      findings: [],
      blocks: [],
      project_type: 'unknown',
      candidate_closing_actions: [],
    },
    items: {},
    ...overrides,
  } as unknown as RemediationState;
}

/**
 * Build a minimal Finding fixture. All fields have sensible defaults; override
 * only what the test needs.
 */
export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    title: "A finding",
    category: "correctness",
    severity: "medium",
    confidence: "medium",
    lens: "maintainability",
    summary: "Something to fix.",
    affected_files: [{ path: "src/a.ts" }],
    evidence: [],
    ...overrides,
  };
}

/**
 * Build a minimal ItemSpec fixture for use in dispatch / model-hint tests.
 */
export function makeSpec(findingId: string, concreteChange: string): ItemSpec {
  return {
    finding_id: findingId,
    concrete_change: concreteChange,
    tests_to_write: [{ name: `test-${findingId}`, assertions: ["passes"] }],
    not_applicable_steps: [],
  };
}
