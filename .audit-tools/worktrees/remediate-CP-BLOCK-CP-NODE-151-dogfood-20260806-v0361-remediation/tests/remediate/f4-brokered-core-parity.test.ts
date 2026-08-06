/**
 * f4-brokered-core-parity.test.ts
 *
 * F4 inv-8 (CE-004) — cross-orchestrator parity by single-sourced core.
 *
 * The brokered host-limit *decision* (detect/resolve active-subagent limit) is a
 * single core that lives in `audit-tools/shared` (src/shared/quota/hostLimits.ts).
 * Both orchestrators import that ONE core; the only legitimate per-orchestrator
 * difference is a thin env-prefix wrapper (AUDIT_CODE vs REMEDIATE_CODE).
 *
 * This is a STRUCTURAL parity test, NOT a forbidden drift test (C-010):
 *   - It does NOT re-assert identical full decisions over a shared fixture in two
 *     suites. The decision logic is exercised exactly once, in shared.
 *   - It asserts (a) both wrappers delegate to the SAME shared core symbol, and
 *     (b) each wrapper's ONLY behavioral delta is its env prefix.
 *
 * If either wrapper stops importing the shared core, re-implements the decision
 * locally, or changes its env prefix, an assertion here fails.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as shared from "audit-tools/shared";
import * as auditHostLimits from "../../src/audit/quota/hostLimits.js";
import * as remediateHostLimits from "../../src/remediate/quota/hostLimits.js";

const AUDIT_SRC = fileURLToPath(
  new URL("../../src/audit/quota/hostLimits.ts", import.meta.url),
);
const REMEDIATE_SRC = fileURLToPath(
  new URL("../../src/remediate/quota/hostLimits.ts", import.meta.url),
);

describe("F4 inv-8 (CE-004): brokered host-limit core is single-sourced", () => {
  it("the decision core is exported once from audit-tools/shared", () => {
    expect(typeof shared.detectHostActiveSubagentLimit).toBe("function");
    expect(typeof shared.resolveHostActiveSubagentLimit).toBe("function");
  });

  it("both orchestrator wrappers delegate to the SAME shared core (no local re-implementation)", () => {
    // The wrappers are one descriptor draw each: they must bind the shared
    // decision core via buildHostLimitBindings and must NOT contain the
    // decision body (env-key lookup, Codex-Desktop fallback, session-config
    // resolution) or a locally-declared prefix.
    for (const [label, src] of [
      ["audit-code", readFileSync(AUDIT_SRC, "utf8")],
      ["remediate-code", readFileSync(REMEDIATE_SRC, "utf8")],
    ] as const) {
      // (a) binds the shared core through the descriptor builder
      expect(
        src.includes('from "audit-tools/shared"'),
        `${label} wrapper must import the core from audit-tools/shared`,
      ).toBe(true);
      expect(
        /buildHostLimitBindings\(/.test(src),
        `${label} wrapper must bind the shared core via buildHostLimitBindings`,
      ).toBe(true);
      // (b) does NOT re-implement the decision body locally
      expect(
        src.includes("_HOST_MAX_ACTIVE_SUBAGENTS"),
        `${label} wrapper must not re-derive the env key (decision lives in shared)`,
      ).toBe(false);
      expect(
        src.includes("CODEX_INTERNAL_ORIGINATOR_OVERRIDE"),
        `${label} wrapper must not re-implement the Codex-Desktop fallback`,
      ).toBe(false);
      // (c) does NOT declare its own prefix — the prefix lives on the
      // orchestrator descriptor (providers/index.ts), the wrapper only draws it.
      expect(
        /ENV_PREFIX\s*=/.test(src),
        `${label} wrapper must not declare a local env prefix (it lives on the descriptor)`,
      ).toBe(false);
    }
  });

  it("the ONLY per-orchestrator delta is the descriptor (env prefix AUDIT_CODE vs REMEDIATE_CODE)", () => {
    const auditSrc = readFileSync(AUDIT_SRC, "utf8");
    const remediateSrc = readFileSync(REMEDIATE_SRC, "utf8");

    // Normalize away the descriptor identifier; the remaining wrapper source
    // must be byte-identical. Any divergence beyond the descriptor binding is a
    // parity break.
    const normalize = (s: string) =>
      s.replace(/(?:AUDIT|REMEDIATE)_CODE_DESCRIPTOR/g, "<DESCRIPTOR>");
    expect(normalize(auditSrc)).toBe(normalize(remediateSrc));
  });

  it("wrapper delta is observable: this orchestrator reads only its own prefix", () => {
    // Tests ONLY remediate-code's wrapper delta — the audit suite owns its own.
    // (No re-assertion of the full shared decision here; that runs once in shared.)
    const own = remediateHostLimits.resolveHostActiveSubagentLimit({
      sessionConfig: {} as never,
      env: { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "4" },
    });
    expect(own?.active_subagents).toBe(4);

    const foreign = remediateHostLimits.detectHostActiveSubagentLimit({
      AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "9",
    } as never);
    expect(foreign).toBeNull();

    // Cross-check the audit wrapper is a distinct prefix instance, not the same
    // object — i.e. the wrappers are genuinely two thin bindings of one core.
    expect(auditHostLimits.resolveHostActiveSubagentLimit).not.toBe(
      remediateHostLimits.resolveHostActiveSubagentLimit,
    );
  });
});
