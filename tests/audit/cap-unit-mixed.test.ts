/**
 * CX-02 landing 5's acceptance test — the cap's UNIT is charged obligation
 * executions, and the derived engine bound can never fire first.
 *
 * The refuted hazard: policy bodies transition WITHOUT dispatching an
 * executor (a consumed consent, a consumed design review). If the cap charged
 * only executor dispatches, those policy transitions would spend engine
 * transition budget and no slot — and with `ENGINE_TRANSITION_HEADROOM = 2`,
 * three uncharged policy transitions already invert the ordering, so the
 * derived backstop (`engineMaxTransitions()`) could fire before the graceful
 * cap and misdiagnose a healthy fold as non-convergent.
 *
 * The engine now charges EVERY `execute` call (spend-before-dispatch), making
 * `transitions <= charged executions` true by construction. This test runs the
 * decided acceptance shape against audit's REAL constants: four policy-only
 * transitions plus a perpetually-actionable state-changing executor must stop
 * at exactly MAX_DRAIN_STEPS charged executions with a structured, resumable
 * budget stop — never the engine bound.
 */
import { test, expect } from "vitest";
import {
  advance,
  type ObligationEngine,
} from "../../src/shared/engine/obligationEngine.js";
import {
  MAX_DRAIN_STEPS,
  engineMaxTransitions,
} from "../../src/audit/orchestrator/advance.js";

interface MixedState {
  policyConsumed: number;
  dispatches: number;
}

test("four policy-only transitions + a perpetual executor stop at exactly the charged-execution cap, resumably", async () => {
  let executions = 0;
  const engine: ObligationEngine<MixedState, unknown, unknown> = {
    priority: ["policy", "work"],
    obligations: [
      {
        // A bespoke policy body: consumes host input and transitions without
        // dispatching any executor — exactly four times.
        id: "policy",
        derive: (s) => (s.policyConsumed < 4 ? "missing" : "satisfied"),
        execute: async (s) => {
          executions++;
          return {
            kind: "transition",
            state: { ...s, policyConsumed: s.policyConsumed + 1 },
          };
        },
      },
      {
        // A perpetually-actionable state-changing executor dispatch.
        id: "work",
        derive: () => "missing",
        execute: async (s) => {
          executions++;
          return { kind: "transition", state: { ...s, dispatches: s.dispatches + 1 } };
        },
      },
    ],
  };

  const outcome = await advance(engine, { policyConsumed: 0, dispatches: 0 }, {}, {
    maxTransitions: engineMaxTransitions(),
    maxExecutions: MAX_DRAIN_STEPS,
  });

  // Exactly the cap executes — the four policy transitions are CHARGED, so
  // dispatches make up the rest and nothing runs past the budget.
  expect(executions).toBe(MAX_DRAIN_STEPS);
  expect(outcome.state.policyConsumed).toBe(4);
  expect(outcome.state.dispatches).toBe(MAX_DRAIN_STEPS - 4);

  // Structured and resumable: a budget stop, never the engine bound (which
  // firing first was the inverted-ordering defect), never a throw.
  expect(outcome.step).toBe(null);
  expect(outcome.stopped).toBe("budget");
  expect(outcome.stoppedBound).toBe(MAX_DRAIN_STEPS);
});
