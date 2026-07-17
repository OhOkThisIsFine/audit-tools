/**
 * 3a contract tests for the `claude-worker` dispatchable source class (the proxied,
 * isolated Claude-harness worker — NOT the conversation host `claude-code`) and the
 * worker-kind axis: union membership, `deriveWorkerKind`, and the validator's new
 * `worker_kind` / `backend_provider` / claude-worker-requires-endpoint+model checks.
 * Plan: docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md (commit 3a).
 */

import { describe, expect, it } from "vitest";

const {
  DISPATCHABLE_SOURCE_PROVIDERS,
  WORKER_KINDS,
  deriveWorkerKind,
} = await import("../../src/shared/types/sessionConfig.ts");
const { validateSessionConfig } = await import(
  "../../src/shared/validation/sessionConfig.ts"
);

/** A fully-specified claude-worker source (what the populate cache emits). */
const CLAUDE_WORKER = {
  id: "claude-worker:nim/z-ai/glm-5.2",
  provider: "claude-worker",
  endpoint: "http://127.0.0.1:8791",
  backend_provider: "nim",
  model: "z-ai/glm-5.2",
  worker_kind: "agentic",
};

function errorsFor(sources) {
  return validateSessionConfig({ sources }).filter((i) => i.severity === "error");
}

describe("claude-worker union membership", () => {
  it("is a first-class DISPATCHABLE_SOURCE_PROVIDERS member", () => {
    expect(DISPATCHABLE_SOURCE_PROVIDERS).toContain("claude-worker");
  });

  it("is distinct from the conversation host — claude-code stays excluded", () => {
    // The four refusal layers key on `claude-code`; the union must never admit it.
    expect(DISPATCHABLE_SOURCE_PROVIDERS).not.toContain("claude-code");
  });
});

describe("deriveWorkerKind", () => {
  it("derives agentic for every harness-driving provider", () => {
    for (const provider of [
      "claude-worker",
      "codex",
      "agy",
      "opencode",
      "worker-command",
      "subprocess-template",
    ]) {
      expect(deriveWorkerKind({ provider }), provider).toBe("agentic");
    }
  });

  it("derives single_shot for openai-compatible (one round-trip, no tools)", () => {
    expect(deriveWorkerKind({ provider: "openai-compatible" })).toBe("single_shot");
  });

  it("an explicit worker_kind on the source wins over the derivation", () => {
    expect(
      deriveWorkerKind({ provider: "openai-compatible", worker_kind: "agentic" }),
    ).toBe("agentic");
    expect(deriveWorkerKind({ provider: "codex", worker_kind: "single_shot" })).toBe(
      "single_shot",
    );
  });

  it("WORKER_KINDS is exactly the two-kind axis", () => {
    expect([...WORKER_KINDS].sort()).toEqual(["agentic", "single_shot"]);
  });
});

describe("validateDispatchableSources — worker_kind / backend_provider", () => {
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

  it("rejects a non-string backend_provider (the coercion hole)", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, backend_provider: { a: 1 } }]);
    expect(errors.some((i) => i.path === "sources[0].backend_provider")).toBe(true);
  });

  it("rejects an empty backend_provider — it is a quota-ledger key segment", () => {
    const errors = errorsFor([{ ...CLAUDE_WORKER, backend_provider: "  " }]);
    expect(errors.some((i) => i.path === "sources[0].backend_provider")).toBe(true);
  });

  it("worker_kind/backend_provider stay optional on the existing providers", () => {
    const nim = {
      provider: "openai-compatible",
      endpoint: "http://nim/v1",
      model: "m",
      api_key_env: "K",
    };
    expect(errorsFor([nim])).toEqual([]);
    expect(errorsFor([{ ...nim, worker_kind: "single_shot", backend_provider: "nim" }])).toEqual([]);
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
    expect(errorsFor([{ provider: "codex" }])).toEqual([]);
  });
});
