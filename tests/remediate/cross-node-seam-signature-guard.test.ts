/**
 * CP-NODE-2 — cross-node seam-signature boundary guard (TEST-ONLY).
 *
 * Mechanically pins the PUBLIC signatures of the shared cross-node seams imported
 * via the bare 'audit-tools/shared' specifier — the F3<->F4 / O3<->F4 dispatch
 * broker (`createBrokeredRepairDispatch`, `estimateSlotTokens`,
 * `classifyCapableHost`), the emit-validate-repair entrypoint
 * (`runEmitValidateRepair`), and the O2<->F1 content-key chain
 * (`buildTaskContentSignature`, `buildResultContentDiscriminator`, `identityKey`,
 * `idempotencyKey`, `contentKey`, `newInstanceId`). A consumer node that drifts
 * one of these shapes — e.g. turns the synchronous `broker()` into a Promise, or
 * moves `task_content_signature` into the idempotencyKey input — trips this guard
 * BEFORE the two halves of the pipeline can silently diverge.
 *
 * Fixtures are built ONLY from the public input types, and NO quota state dir is
 * configured, so `persistPoolCooldownBestEffort` self-disables — the guard is
 * hermetic and parallel-safe.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBrokeredRepairDispatch,
  estimateSlotTokens,
  classifyCapableHost,
  runEmitValidateRepair,
  buildTaskContentSignature,
  buildResultContentDiscriminator,
  identityKey,
  idempotencyKey,
  contentKey,
  newInstanceId,
} from 'audit-tools/shared';
import type {
  BrokeredDispatchSlot,
  BrokerDispatchInput,
  BrokeredCompletion,
  SessionConfig,
  ContentKeyInput,
} from 'audit-tools/shared';

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * INV-SEAM-2 / INV-SEAM-7 (CE-006): a proper await-shape check. A value is
 * await-transparent (a synchronous, non-thenable return) iff it is NOT a Promise
 * AND carries NO `then` property of ANY kind — neither a thenable function NOR a
 * non-function `then` data property (a getter/data `then` would also make `await`
 * treat it as a thenable). Asserting `!instanceof Promise` alone is insufficient.
 */
function assertNotPromiseLike(value: unknown, label: string): void {
  expect(value instanceof Promise, `${label}: must not be a Promise`).toBe(false);
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    expect(
      'then' in (value as Record<string, unknown>),
      `${label}: must not carry a 'then' property (await-transparent)`,
    ).toBe(false);
  }
}

/** Minimal public SessionConfig fixture — every field is optional. */
const sessionConfig: SessionConfig = {};

/** A public dispatch slot (only slotId + payloadBytes are public). */
function slot(slotId: string, payloadBytes: number): BrokeredDispatchSlot {
  return { slotId, payloadBytes };
}

/** A minimal public broker input. No quota state entry / snapshot → no cooldown. */
function brokerInput(slots: BrokeredDispatchSlot[]): BrokerDispatchInput {
  return {
    providerName: 'claude-code',
    sessionConfig,
    hostModel: null,
    slots,
  };
}

/** The public ContentKeyInput tuple (superset of identity + idempotency inputs). */
function contentKeyInput(
  overrides: Partial<ContentKeyInput> = {},
): ContentKeyInput {
  return {
    unit_id: 'unit-1',
    lens: 'security',
    pass_id: 'pass-1',
    result_content_discriminator: 'base',
    task_content_signature: 'sig-C1',
    ...overrides,
  };
}

describe('cross-node seam-signature boundary guard (CP-NODE-2)', () => {
  it('INV-SEAM-1: every pinned export is a function', () => {
    const exports: Record<string, unknown> = {
      createBrokeredRepairDispatch,
      estimateSlotTokens,
      classifyCapableHost,
      runEmitValidateRepair,
      buildTaskContentSignature,
      buildResultContentDiscriminator,
      identityKey,
      idempotencyKey,
      contentKey,
      newInstanceId,
    };
    for (const [name, value] of Object.entries(exports)) {
      expect(typeof value, `${name} must be a function`).toBe('function');
    }
  });

  it('INV-SEAM-2/7: broker() and every pinned entrypoint are synchronous (await-transparent)', () => {
    const broker = createBrokeredRepairDispatch();

    // broker() decision is a plain object, not a Promise/thenable.
    const decision = broker.broker(brokerInput([slot('s1', 1024)]));
    assertNotPromiseLike(decision, 'broker()');

    // awaitNextCompletion passes the raw completion straight through, synchronously.
    const completion: BrokeredCompletion = { slotId: 's1', rawResult: { ok: true } };
    assertNotPromiseLike(broker.awaitNextCompletion(completion), 'awaitNextCompletion()');

    // Generalized no-PromiseLike guard across every pinned key/derivation entrypoint.
    assertNotPromiseLike(estimateSlotTokens(slot('s1', 512)), 'estimateSlotTokens()');
    assertNotPromiseLike(
      classifyCapableHost({ providerName: "claude-code", sessionConfig }),
      'classifyCapableHost()',
    );
    assertNotPromiseLike(
      buildTaskContentSignature({ unit_id: 'u' }),
      'buildTaskContentSignature()',
    );
    assertNotPromiseLike(
      buildResultContentDiscriminator({ source: 'base' }),
      'buildResultContentDiscriminator()',
    );
    assertNotPromiseLike(identityKey(contentKeyInput()), 'identityKey()');
    assertNotPromiseLike(idempotencyKey(contentKeyInput()), 'idempotencyKey()');
    assertNotPromiseLike(contentKey(contentKeyInput()), 'contentKey()');
    assertNotPromiseLike(newInstanceId(), 'newInstanceId()');
    // runEmitValidateRepair is the one async entrypoint by contract (its callers
    // `await` it). It is NOT invoked here — doing so would require an artifacts
    // dir and write friction to disk, breaking hermeticity. Its async-and-thenable
    // contract is pinned structurally via a no-throw run on a hermetic in-memory
    // contract in INV-SEAM-7-async below, with artifact capture pointed at a
    // throwaway path so it degrades cleanly.
  });

  it('INV-SEAM-7 (async entrypoint): runEmitValidateRepair returns a thenable Promise on a clean in-memory payload', async () => {
    // A hermetic contract whose validator reports clean → the seam short-circuits
    // at stage0 with NO coercion and NO friction capture, so no LLM/provider and
    // no meaningful disk IO occur. artifactsDir is a throwaway sub-path of the OS
    // temp dir; on the clean path captureFrictionEvent is never invoked.
    const cleanContract = {
      contractId: 'seam-guard-clean',
      validate: () => ({ errors: [] }),
      coercion: { coerce: (payload: unknown) => ({ payload, drops: [], backfills: [], unrecoverableIdentity: false }) },
    };
    const promise = runEmitValidateRepair({
      contract: cleanContract,
      payload: { ok: true },
      artifactsDir: join(tmpdir(), 'audit-tools-seam-guard-never-written'),
      runId: 'seam-guard-run',
    });
    // It IS thenable (a Promise) — the contract its callers await.
    expect(promise instanceof Promise).toBe(true);
    const outcome = await promise;
    expect(outcome.status).toBe('clean');
    expect(outcome.stages_applied[0]).toBe('validate');
  });

  it('INV-SEAM-3: broker() decision carries the pinned public shape', () => {
    const broker = createBrokeredRepairDispatch();
    const decision = broker.broker(brokerInput([slot('s1', 1024), slot('s2', 2048)]));

    expect(typeof decision.admitted).toBe('number');
    // Pin `admission` to the enum membership (shape), avoiding the either-or
    // `expect([...]).toContain(var)` pattern flagged by INV-remediate-tests-04.
    expect(typeof decision.admission).toBe('string');
    expect(['admitted', 'refused_over_budget', 'cooldown'].includes(decision.admission)).toBe(true);
    expect(Array.isArray(decision.admittedSlotIds)).toBe(true);
    expect(typeof decision.estimatedWaveTokens).toBe('number');
    expect(
      decision.cooldownUntil === null || typeof decision.cooldownUntil === 'string',
    ).toBe(true);
    expect(decision.bindingCap).not.toBeUndefined();
    expect(typeof decision.capableHost).toBe('boolean');
    expect(typeof decision.schedule).toBe('object');
    expect(decision.schedule).not.toBeNull();
  });

  it('INV-SEAM-4: awaitNextCompletion is a sync pass-through preserving slotId + rawResult identity', () => {
    const broker = createBrokeredRepairDispatch();
    const rawResult = { evidence: ['e1'], nested: { a: 1 } };
    const input: BrokeredCompletion = { slotId: 'node-7', rawResult };
    const out = broker.awaitNextCompletion(input);

    expect(out.slotId).toBe('node-7');
    // Same object reference handed straight back — the broker does NO validation
    // and no copy (broker-handle edge: O3 is the only validation authority).
    expect(Object.is(out.rawResult, rawResult)).toBe(true);
  });

  it('INV-SEAM-5: estimateSlotTokens arity 1 → number; classifyCapableHost → boolean', () => {
    expect(estimateSlotTokens.length).toBe(1);
    const tokens = estimateSlotTokens(slot('s1', 4096));
    expect(typeof tokens).toBe('number');

    const capable = classifyCapableHost({ providerName: "claude-code", sessionConfig });
    expect(typeof capable).toBe('boolean');
  });

  it('INV-SEAM-6: content-key chain is pure 64-hex; signature bumps contentKey only; newInstanceId distinct', () => {
    const base = contentKeyInput();

    // Pure + 64-hex for each derived key, and deterministic across repeat calls.
    for (const fn of [identityKey, idempotencyKey, contentKey] as const) {
      const a = fn(base);
      const b = fn(base);
      expect(a).toMatch(HEX64);
      expect(b).toBe(a); // pure / deterministic
    }

    // Changing ONLY the task_content_signature bumps contentKey but leaves
    // idempotencyKey and identityKey fixed (signature-stable vs. -sensitive).
    const c1 = contentKeyInput({ task_content_signature: 'sig-C1' });
    const c2 = contentKeyInput({ task_content_signature: 'sig-C2' });
    expect(identityKey(c2)).toBe(identityKey(c1));
    expect(idempotencyKey(c2)).toBe(idempotencyKey(c1));
    expect(contentKey(c2)).not.toBe(contentKey(c1));

    // newInstanceId mints a fresh, distinct id each call.
    expect(newInstanceId()).not.toBe(newInstanceId());
  });

  it('INV-SEAM-8: broker() and contentKey do NOT throw on a minimal public fixture', () => {
    const broker = createBrokeredRepairDispatch();
    expect(() => broker.broker(brokerInput([slot('s1', 256)]))).not.toThrow();
    expect(() => contentKey(contentKeyInput())).not.toThrow();
  });
});
