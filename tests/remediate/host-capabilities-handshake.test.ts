/**
 * C1: persisted host-capability handshake.
 *
 * Tests the PURE resolver `resolveHostCapabilities(explicit, persisted)` — a DI
 * seam so the per-field `explicit ?? persisted ?? floor` merge is exercised
 * without driving a full next-step. The dispatch-build site feeds the resolved
 * values downstream and persists only the explicitly-supplied delta.
 */
import { describe, it, expect } from "vitest";
import { resolveHostCapabilities } from "../../src/remediate/steps/nextStep.js";
import type { HostCapabilities } from "../../src/remediate/state/store.js";

describe("resolveHostCapabilities (C1 per-field handshake merge)", () => {
  it("reuses the persisted value (NOT the floor) when a field is omitted", () => {
    const persisted: HostCapabilities = {
      can_dispatch_subagents: true,
      max_concurrent: 4,
      context_tokens: 200_000,
      output_tokens: 8_000,
      model_id: "m1",
    };
    // Explicit supplies nothing → every field falls through to persisted.
    const { resolved } = resolveHostCapabilities({}, persisted);
    expect(resolved.context_tokens).toBe(200_000); // persisted, not the 32k floor
    expect(resolved.max_concurrent).toBe(4);
    expect(resolved.output_tokens).toBe(8_000);
    expect(resolved.can_dispatch_subagents).toBe(true);
    expect(resolved.model_id).toBe("m1");
  });

  it("per-field override keeps the omitted persisted fields (no whole-object clobber)", () => {
    const persisted: HostCapabilities = {
      can_dispatch_subagents: true,
      max_concurrent: 4,
      context_tokens: 200_000,
      output_tokens: 8_000,
      model_id: "m1",
    };
    // Override only max_concurrent; everything else must survive from persisted.
    const { resolved, toPersist } = resolveHostCapabilities(
      { max_concurrent: 8 },
      persisted,
    );
    expect(resolved.max_concurrent).toBe(8); // overridden
    expect(resolved.context_tokens).toBe(200_000); // preserved
    expect(resolved.output_tokens).toBe(8_000); // preserved
    expect(resolved.model_id).toBe("m1"); // preserved
    // The persist delta carries ONLY the explicitly-supplied field.
    expect(toPersist).toEqual({ max_concurrent: 8 });
  });

  it("true first contact (nothing persisted) floors context_tokens at 32k", () => {
    const { resolved, toPersist } = resolveHostCapabilities(undefined, undefined);
    expect(resolved.context_tokens).toBe(32_000);
    // The floor is NOT persisted — only explicitly-supplied fields are.
    expect(toPersist).toEqual({});
  });

  it("an explicit context_tokens overrides the first-contact floor and is persisted", () => {
    const { resolved, toPersist } = resolveHostCapabilities(
      { context_tokens: 128_000 },
      undefined,
    );
    expect(resolved.context_tokens).toBe(128_000);
    expect(toPersist).toEqual({ context_tokens: 128_000 });
  });

  it("corrupt / non-finite persisted numbers degrade without throwing", () => {
    const corrupt = {
      max_concurrent: Number.NaN,
      context_tokens: Number.POSITIVE_INFINITY,
      output_tokens: "not-a-number",
    } as unknown as HostCapabilities;
    expect(() => resolveHostCapabilities({}, corrupt)).not.toThrow();
    const { resolved } = resolveHostCapabilities({}, corrupt);
    // Non-finite persisted numbers degrade to undefined; context is NOT re-floored
    // because a handshake exists (not true first contact).
    expect(resolved.max_concurrent).toBeUndefined();
    expect(resolved.context_tokens).toBeUndefined();
    expect(resolved.output_tokens).toBeUndefined();
  });

  it("only explicitly-supplied fields appear in the persist delta", () => {
    const { toPersist } = resolveHostCapabilities(
      {
        can_dispatch_subagents: false,
        model_id: "mX",
        models: [{ rank: 0 }],
      },
      { max_concurrent: 2 },
    );
    expect(toPersist).toEqual({
      can_dispatch_subagents: false,
      model_id: "mX",
      models: [{ rank: 0 }],
    });
    // max_concurrent was persisted-only (not supplied this call) → not in the delta.
    expect("max_concurrent" in toPersist).toBe(false);
  });
});
