import { describe, it, expect } from "vitest";
import { isEnvelope } from "../../src/remediate/contractPipeline/artifactStore.js";
import { CONTRACT_PIPELINE_VALIDATORS } from "../../src/remediate/validation/contractPipeline.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  type ContractPipelineArtifactName,
} from "audit-tools/shared";

// These tests cover the `validate-artifact` CLI command's envelope-unwrap
// behavior (F8 / CP-NODE-3) build-free: they exercise the exact decision the
// command's action makes — `isEnvelope(parsed) ? parsed.payload : parsed`, then
// the matching validator — using the canonical predicate and validator registry
// the action itself imports, so no dist build / subprocess race is required.

function makeGoalSpec(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: goalId,
    objective: "Improve test coverage.",
    non_goals: [],
    success_criteria: ["All tests pass."],
    source_type: "conversation" as const,
    created_at: new Date().toISOString(),
  };
}

/** Mirror of the command action's parse → unwrap → validate decision. */
function validateArtifactInput(name: string, raw: string): {
  status: "ok" | "error";
  exit: 0 | 1 | 2;
} {
  const validator =
    CONTRACT_PIPELINE_VALIDATORS[name as ContractPipelineArtifactName];
  if (!validator) return { status: "error", exit: 2 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "error", exit: 2 };
  }
  const payload = isEnvelope(parsed) ? parsed.payload : parsed;
  const errors = validator(payload, name as ContractPipelineArtifactName).filter(
    (issue) => issue.severity === "error",
  );
  return errors.length === 0
    ? { status: "ok", exit: 0 }
    : { status: "error", exit: 1 };
}

function envelope(name: string, payload: unknown) {
  return {
    artifact_name: name,
    content_hash: "deadbeef",
    dependency_hashes: {},
    payload,
  };
}

describe("isEnvelope canonical predicate", () => {
  it("recognizes a well-formed envelope", () => {
    expect(isEnvelope(envelope("goal_spec", makeGoalSpec()))).toBe(true);
  });

  it("recognizes an envelope whose payload is an array", () => {
    expect(isEnvelope(envelope("goal_spec", [1, 2, 3]))).toBe(true);
  });

  it("rejects a payload with artifact_name but NO content_hash", () => {
    // A plain GoalSpec carries no content_hash, so it is NOT an envelope even
    // though a contract payload could incidentally carry an artifact_name-like
    // field — the missing content_hash is what disqualifies it.
    expect(
      isEnvelope({ artifact_name: "goal_spec", payload: makeGoalSpec() }),
    ).toBe(false);
  });

  it("rejects a plain payload object", () => {
    expect(isEnvelope(makeGoalSpec())).toBe(false);
  });

  it("rejects non-records", () => {
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope("string")).toBe(false);
    expect(isEnvelope([1, 2])).toBe(false);
  });
});

describe("validate-artifact envelope unwrap", () => {
  it("validates a wrapped (enveloped) artifact -> ok", () => {
    const raw = JSON.stringify(envelope("goal_spec", makeGoalSpec()));
    expect(validateArtifactInput("goal_spec", raw)).toEqual({
      status: "ok",
      exit: 0,
    });
  });

  it("validates a plain payload -> ok", () => {
    const raw = JSON.stringify(makeGoalSpec());
    expect(validateArtifactInput("goal_spec", raw)).toEqual({
      status: "ok",
      exit: 0,
    });
  });

  it("unwraps an envelope whose payload validates regardless of wrapping", () => {
    // Same payload, wrapped vs. plain, must produce the same verdict.
    const plain = validateArtifactInput("goal_spec", JSON.stringify(makeGoalSpec()));
    const wrapped = validateArtifactInput(
      "goal_spec",
      JSON.stringify(envelope("goal_spec", makeGoalSpec())),
    );
    expect(wrapped).toEqual(plain);
  });

  it("reports an invalid WRAPPED payload as error -> exit 1", () => {
    const bad = { ...makeGoalSpec(), objective: undefined };
    const raw = JSON.stringify(envelope("goal_spec", bad));
    const res = validateArtifactInput("goal_spec", raw);
    expect(res.status).toBe("error");
    expect(res.exit).toBe(1);
  });

  it("reports an invalid PLAIN payload as error -> exit 1", () => {
    const bad = { ...makeGoalSpec(), objective: undefined };
    const raw = JSON.stringify(bad);
    const res = validateArtifactInput("goal_spec", raw);
    expect(res.status).toBe("error");
    expect(res.exit).toBe(1);
  });

  it("does NOT unwrap a payload with incidental artifact_name but no content_hash", () => {
    // Wrapped-shaped but missing content_hash => treated as the payload itself.
    // The validator then sees the envelope-ish object (not a GoalSpec) and fails.
    const notAnEnvelope = {
      artifact_name: "goal_spec",
      payload: makeGoalSpec(),
    };
    const res = validateArtifactInput("goal_spec", JSON.stringify(notAnEnvelope));
    expect(res.status).toBe("error");
    expect(res.exit).toBe(1);
  });

  it("returns exit 2 for non-JSON input", () => {
    expect(validateArtifactInput("goal_spec", "{not json")).toEqual({
      status: "error",
      exit: 2,
    });
  });

  it("returns exit 2 for an unknown artifact name", () => {
    const raw = JSON.stringify(makeGoalSpec());
    expect(validateArtifactInput("not_a_real_artifact", raw)).toEqual({
      status: "error",
      exit: 2,
    });
  });
});
