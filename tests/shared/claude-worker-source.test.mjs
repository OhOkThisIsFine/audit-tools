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

  it("an explicit worker_kind on the source wins over the derivation", () => {
    expect(
      deriveWorkerKind({ transport: "openai-compatible", worker_kind: "agentic" }),
    ).toBe("agentic");
    expect(deriveWorkerKind({ transport: "codex", worker_kind: "single_shot" })).toBe(
      "single_shot",
    );
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
