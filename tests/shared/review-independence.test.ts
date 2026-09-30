import { describe, expect, test } from "vitest";
import { ReviewDeclarationSchema, reviewIndependenceIssue } from "../../src/shared/types/reviewIndependence.js";
describe("host-declared review independence", () => {
  test("required independent review refuses degraded or unavailable contexts", () => {
    expect(reviewIndependenceIssue("independent", { mode: "independent", reason: "Fresh context without authorship" })).toBeNull();
    expect(reviewIndependenceIssue("independent", { mode: "degraded", reason: "No independent context" })).toBeTruthy();
    expect(reviewIndependenceIssue("independent", { mode: "unavailable", reason: "Reviewer unavailable" })).toBeTruthy();
  });
  test("explicit degraded permission admits only recorded degradation", () => {
    expect(reviewIndependenceIssue("degraded_allowed", { mode: "degraded", reason: "Independent context unavailable" })).toBeNull();
    expect(reviewIndependenceIssue("degraded_allowed", { mode: "unavailable", reason: "No reviewer" })).toBeTruthy();
    expect(ReviewDeclarationSchema.safeParse({ mode: "independent", reason: "" }).success).toBe(false);
    expect(ReviewDeclarationSchema.safeParse({ mode: "self", reason: "same author" }).success).toBe(false);
  });
});

import { parseReviewSubmissionEnvelope } from "../../src/shared/types/reviewIndependence.js";
test("required submissions bind declaration and result to the expected tool prompt", () => {
  const digest = "a".repeat(64);
  const envelope = { contract_version: "review-submission/v1", prompt_sha256: digest, review: { mode: "independent", reason: "Separate context" }, result: { verdict: "approved" } };
  expect(parseReviewSubmissionEnvelope(envelope, { requirement: "independent", promptSha256: digest })).toMatchObject({ ok: true, result: { verdict: "approved" }, review: { mode: "independent" } });
  for (const raw of [envelope.result, { ...envelope, prompt_sha256: "b".repeat(64) }, { ...envelope, review: { mode: "degraded", reason: "same author" } }, { ...envelope, review: { mode: "unavailable", reason: "no context" } }]) {
    expect(parseReviewSubmissionEnvelope(raw, { requirement: "independent", promptSha256: digest }).ok).toBe(false);
  }
  expect(parseReviewSubmissionEnvelope(envelope, { requirement: "independent" }).ok).toBe(false);
  expect(parseReviewSubmissionEnvelope(envelope.result, { requirement: "ordinary" })).toEqual({ ok: true, result: envelope.result });
});

import { renderIndependentReviewMandate } from "../../src/shared/prompts.js";
test("a required independent mandate never offers an inline self-review fallback", () => {
  expect(renderIndependentReviewMandate("full")).not.toContain("execute it inline");
  expect(renderIndependentReviewMandate("full")).toContain("unavailable");
});
