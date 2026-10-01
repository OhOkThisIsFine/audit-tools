import type { RemediationState } from '../../src/remediate/state/store.js';

import { canonicalPlanFixture } from './helpers/canonicalPlanFixture.js';

/** Explicit canonical runtime fixture; overrides use the real production contract. */
export function makeState(overrides: Partial<RemediationState> = {}): RemediationState {
  return { status: 'pending', plan: canonicalPlanFixture({ plan_id: 'P1' }), items: {}, ...overrides };
}
