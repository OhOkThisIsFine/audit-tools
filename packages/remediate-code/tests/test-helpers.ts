import type { RemediationState } from '../src/state/store.js';

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
