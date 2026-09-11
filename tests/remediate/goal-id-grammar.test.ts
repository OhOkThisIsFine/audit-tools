/**
 * The `goal_id` grammar (idRegistry) and its use on the way in from the LLM.
 *
 * `goal_id` is the identity joining every contract-pipeline artifact and the key
 * `validateGoalIdConsistency` compares for exact equality. It is the ONE id in
 * the pipeline minted by the LLM rather than by the tool, and its whole
 * specification the model ever saw was the prompt placeholder
 * `<stable-identifier>` — so the format used to be whatever the model emitted,
 * read back verbatim through a `typeof === "string"` test.
 *
 * These tests pin the grammar itself AND the coercion the one producer path
 * (`deriveFinalizedModuleContracts`) applies, so a regression to a verbatim read
 * is red here rather than discovered as a consistency-gate mismatch on a run.
 */
import { describe, it, expect } from "vitest";
import {
  GOAL_ID_MAX_LENGTH,
  GOAL_ID_PATTERN,
  coerceGoalId,
  isGoalId,
} from "../../src/remediate/contractPipeline/idRegistry.js";
import { deriveFinalizedModuleContracts } from "../../src/remediate/contractPipeline/derive.js";
import { CP_FINALIZED_MODULE_CONTRACTS_VERSION } from "../../src/remediate/validation/contractPipeline.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("goal-id grammar", () => {
  it("admits the ids real runs and fixtures actually use", () => {
    // `G1`/`GOAL-001`/`goal-abc` are the values in this repo's own tests, and
    // `goal-self-audit-2026-08-21-first-draw` is a real run's emitted id. A
    // grammar that rejected the ids already in the wild would be a migration
    // wearing a validator's name.
    for (const id of [
      "g1",
      "goal-001",
      "goal-abc",
      "goal-self-audit-2026-08-21-first-draw",
      "auth",
      "g",
    ]) {
      expect(isGoalId(id), `${id} must be a valid goal id`).toBe(true);
    }
  });

  it("refuses what is not an identity", () => {
    // The three shapes the verbatim read silently admitted. Each is a NON-id:
    // empty, the unsubstituted prompt placeholder, and a free-text sentence the
    // model wrote instead of an id.
    for (const bad of [
      "",
      "<stable-identifier>",
      "Harden the auth flow.",
      "has_underscore",
      " has space ",
      "1-leading-digit",
      "-leading-hyphen",
      "trailing-hyphen-",
      "UPPERCASE",
    ]) {
      expect(isGoalId(bad), `${JSON.stringify(bad)} must be refused`).toBe(false);
    }
  });

  it("bounds the length so an id cannot become a payload", () => {
    const tooLong = "a".repeat(GOAL_ID_MAX_LENGTH + 1);
    expect(isGoalId(tooLong)).toBe(false);
    expect(isGoalId("a".repeat(GOAL_ID_MAX_LENGTH))).toBe(true);
  });

  it("coerces a host near-miss to the canonical form, deterministically", () => {
    // The LLM is the producer, so a near-miss is the EXPECTED input shape.
    // Lowercasing is load-bearing: `validateGoalIdConsistency` compares for
    // exact string equality, so `Goal-1` from one shard and `goal-1` from
    // another would otherwise red the run on a mismatch that does not exist.
    expect(coerceGoalId("Goal-001")).toBe("goal-001");
    expect(coerceGoalId("goal_001")).toBe("goal-001");
    expect(coerceGoalId("Goal 1")).toBe("goal-1");
    expect(coerceGoalId("  Auth-Module  ")).toBe("auth-module");
    // Deterministic: same input, same id.
    expect(coerceGoalId("Goal 1")).toBe(coerceGoalId("Goal 1"));
  });

  it("never invents an identity from nothing", () => {
    // An absent or unusable value yields the empty string, which is every
    // reader's existing "no goal id was established" signal — the coerce must
    // not mint a placeholder that would then pass the consistency gate.
    for (const bad of [undefined, null, 42, {}, [], "", "<stable-identifier>"]) {
      expect(coerceGoalId(bad)).toBe("");
    }
  });

  it("the pattern is the single source the predicate reads", () => {
    // Guards against a predicate that stops consulting the exported pattern
    // (the drift shape this registry exists to prevent).
    expect(GOAL_ID_PATTERN.test("goal-abc")).toBe(true);
    expect(GOAL_ID_PATTERN.test("Goal-ABC")).toBe(false);
  });
});

describe("deriveFinalizedModuleContracts validates goal_id on the way in", () => {
  const draftsWith = (goalId: unknown) => ({
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: goalId,
    module_contracts: [],
  });

  it("canonicalizes a near-miss rather than carrying it verbatim", () => {
    const derived = deriveFinalizedModuleContracts(
      draftsWith("Goal-001"),
      undefined,
      { created_at: CREATED_AT },
    );
    expect(derived.goal_id).toBe("goal-001");
  });

  it("refuses an unsubstituted placeholder instead of persisting it as an id", () => {
    // The exact defect: the model leaves the prompt's placeholder in place and
    // the verbatim read made `<stable-identifier>` the run's joining identity,
    // matching every other artifact that made the same mistake.
    const derived = deriveFinalizedModuleContracts(
      draftsWith("<stable-identifier>"),
      undefined,
      { created_at: CREATED_AT },
    );
    expect(derived.goal_id).toBe("");
  });

  it("refuses a free-text sentence", () => {
    const derived = deriveFinalizedModuleContracts(
      draftsWith("Harden the auth flow."),
      undefined,
      { created_at: CREATED_AT },
    );
    expect(derived.goal_id).toBe("");
  });

  it("keeps an already-canonical id unchanged", () => {
    const derived = deriveFinalizedModuleContracts(
      draftsWith("goal-self-audit-2026-08-21-first-draw"),
      undefined,
      { created_at: CREATED_AT },
    );
    expect(derived.goal_id).toBe("goal-self-audit-2026-08-21-first-draw");
  });
});
