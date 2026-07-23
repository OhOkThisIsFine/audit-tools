/**
 * 3a contract tests for the `claude-worker` dispatchable source class (the proxied,
 * isolated Claude-harness worker — NOT the conversation host `claude-code`) and the
 * worker-kind axis: union membership, `deriveWorkerKind`, and the validator's new
 * `worker_kind` / `service` / claude-worker-requires-endpoint+model checks.
 * Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md (commit 3a).
 */

import { describe, expect, it } from "vitest";

const {
  DISPATCHABLE_TRANSPORTS,
  WORKER_KINDS,
  deriveWorkerKind,
} = await import("../../src/shared/types/sessionConfig.ts");
const { validateSessionConfig } = await import(
  "../../src/shared/validation/sessionConfig.ts"
);

/** A fully-specified claude-worker source (what the populate cache emits). */
const CLAUDE_WORKER = {
  id: "claude-worker:nim/z-ai/glm-5.2",
  transport: "claude-worker",
  endpoint: "http://127.0.0.1:8791",
  service: "nim",
  model: "z-ai/glm-5.2",
  worker_kind: "agentic",
};

function errorsFor(sources) {
  return validateSessionConfig({ sources }).filter((i) => i.severity === "error");
}

describe("claude-worker union membership", () => {
  it("is a first-class DISPATCHABLE_TRANSPORTS member", () => {
    expect(DISPATCHABLE_TRANSPORTS).toContain("claude-worker");
  });

  it("is distinct from the conversation host — claude-code stays excluded", () => {
    // The four refusal layers key on `claude-code`; the union must never admit it.
    expect(DISPATCHABLE_TRANSPORTS).not.toContain("claude-code");
  });
});

describe("deriveWorkerKind", () => {
  it("derives agentic for every harness-driving transport", () => {
    for (const transport of [
      "claude-worker",
      "codex",
      "agy",
      "opencode",
      "worker-command",
      "subprocess-template",
    ]) {
      expect(deriveWorkerKind({ transport }), transport).toBe("agentic");
    }
  });

  it("derives single_shot for openai-compatible (one round-trip, no tools)", () => {
    expect(deriveWorkerKind({ transport: "openai-compatible" })).toBe("single_shot");
  });

  it("a fixed-kind transport is authoritative — a contradicting declaration is ignored", () => {
    // The transport IS the fact: `claude -p`/a harness CLI always drives a tool loop,
    // an openai-compatible POST is always one round-trip. Honoring a contradicting
    // declaration would let config text bypass worker-kind safety rules (the
    // burst-limited storm class — laneWorkerKindConflict).
    expect(
      deriveWorkerKind({ transport: "openai-compatible", worker_kind: "agentic" }),
    ).toBe("single_shot");
    expect(deriveWorkerKind({ transport: "codex", worker_kind: "single_shot" })).toBe(
      "agentic",
    );
    expect(
      deriveWorkerKind({ transport: "claude-worker", worker_kind: "single_shot" }),
    ).toBe("agentic");
  });

  it("the declaration decides only for the genuinely-ambiguous command-shaped transports", () => {
    expect(
      deriveWorkerKind({ transport: "worker-command", worker_kind: "single_shot" }),
    ).toBe("single_shot");
    expect(
      deriveWorkerKind({ transport: "subprocess-template", worker_kind: "single_shot" }),
    ).toBe("single_shot");
    expect(deriveWorkerKind({ transport: "worker-command" })).toBe("agentic");
  });

  it("WORKER_KINDS is exactly the two-kind axis", () => {
    expect([...WORKER_KINDS].sort()).toEqual(["agentic", "single_shot"]);
  });
});

describe("validateDispatchableSources — worker_kind / service", () => {
  it("accepts a fully-specified claude-worker source", () => {
    expect(errorsFor([CLAUDE_WORKER])).toEqual([]);
  });

  it("rejects an unknown worker_kind", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, worker_kind: "batch" }]);
    expect(errors.some((i) => i.path === "sources[0].worker_kind")).toBe(true);
  });

  it("rejects a non-string worker_kind", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, worker_kind: 1 }]);
    expect(errors.some((i) => i.path === "sources[0].worker_kind")).toBe(true);
  });

  it("rejects a non-string service (the coercion hole)", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, service: { a: 1 } }]);
    expect(errors.some((i) => i.path === "sources[0].service")).toBe(true);
  });

  it("rejects an empty service — it is a quota-ledger key segment", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, service: "  " }]);
    expect(errors.some((i) => i.path === "sources[0].service")).toBe(true);
  });

  it("worker_kind/service stay optional on the existing transports", () => {
    const nim = {
      transport: "openai-compatible",
      endpoint: "http://nim/v1",
      model: "m",
      api_key_env: "K",
    };
    expect(errorsFor([nim])).toEqual([]);
    expect(errorsFor([{ ...nim, worker_kind: "single_shot", service: "nim" }])).toEqual([]);
  });
});

describe("validateDispatchableSources — claude-worker requirements", () => {
  it("requires endpoint (the repair-proxy url)", () => {
    const { endpoint: _endpoint, ...noEndpoint } = CLAUDE_WORKER;
    const errors = errorsFor([noEndpoint]);
    expect(errors.some((i) => i.path === "sources[0].endpoint")).toBe(true);
  });

  it("requires model (the backend-native id)", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, model: "" }]);
    expect(errors.some((i) => i.path === "sources[0].model")).toBe(true);
  });

  it("does NOT impose endpoint/model on other providers", () => {
    // codex has a default launcher; endpoint/model stay optional there.
    expect(errorsFor([{ transport: "codex" }])).toEqual([]);
  });
});

describe("validateDispatchableSources — burst_limited shape + semantic warnings", () => {
  const warningsFor = (sources) =>
    validateSessionConfig({ sources }).filter((i) => i.severity === "warning");

  it("accepts a boolean and rejects a non-boolean", () => {
    expect(errorsFor([{ ...CLAUDE_WORKER, burst_limited: true }])).toEqual([]);
    const errors = errorsFor([{ ...CLAUDE_WORKER, burst_limited: "yes" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("sources[0].burst_limited");
  });

  // The COMPATIBILITY rule is deliberately NOT a validator error: an error-severity
  // issue makes readSourceDeclaration degrade the WHOLE declaration to empty, which
  // would turn one incompatible lane into a total pool loss. Per-lane enforcement
  // lives in resolveAmbientSources / collectDispatchableSources; static validation
  // WARNS so the conflict is visible before a run without costing the pool.
  it("an agentic burst-limited source: zero errors, one refused-at-assembly warning", () => {
    const src = { ...CLAUDE_WORKER, burst_limited: true };
    expect(errorsFor([src])).toEqual([]);
    const warnings = warningsFor([src]);
    expect(warnings.some((i) => i.path === "sources[0].burst_limited")).toBe(true);
  });

  it("a single-shot burst-limited source draws no warning", () => {
    const src = {
      transport: "openai-compatible",
      endpoint: "http://127.0.0.1:4000/v1",
      model: "m",
      burst_limited: true,
    };
    expect(errorsFor([src])).toEqual([]);
    expect(warningsFor([src])).toEqual([]);
  });

  it("a worker_kind contradicting a fixed-kind transport draws an ignored-declaration warning", () => {
    const src = { ...CLAUDE_WORKER, worker_kind: "single_shot" };
    expect(errorsFor([src])).toEqual([]);
    const warnings = warningsFor([src]);
    expect(warnings.some((i) => i.path === "sources[0].worker_kind")).toBe(true);
  });
});
