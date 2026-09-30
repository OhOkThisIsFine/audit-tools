import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bindContractReviewPrompt, contractReviewBindingPath } from "../../src/remediate/contractPipeline/contractReviewBinding.js";
import { contractInputFilePath, contractArtifactFilePath, readContractArtifact, writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { ingestContractArtifacts } from "../../src/remediate/steps/contractPipeline.js";
import { reviewRequirementForRole, renderContractPipelinePrompt } from "../../src/remediate/steps/contractPipelinePrompts.js";
import { CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION } from "../../src/shared/types/contractPipeline/obligations.js";
const roots: string[] = [];
const payload = { contract_version: CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION, goal_id: "G1", counterexamples: [], created_at: "2026-01-01T00:00:00Z" };
async function fixture(depth?: "light" | "full") {
  const dir = await mkdtemp(join(tmpdir(), "review-envelope-")); roots.push(dir);
  const requirement = reviewRequirementForRole("critic", depth);
  await bindContractReviewPrompt({ artifactsDir: dir, artifact: "counterexample", role: "critic", emissionId: "emit-one", requirement, prompt: "Review the bound module contracts." });
  const binding = JSON.parse(await readFile(contractReviewBindingPath(dir, "counterexample"), "utf8")) as { prompt_sha256: string };
  return { dir, binding, requirement };
}
async function submit(dir: string, digest: string, mode = "independent", result: unknown = payload) {
  await writeFile(contractInputFilePath(dir, "counterexample"), JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256: digest, review: { mode, reason: "Recorded context independence" }, result }));
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("a bound independent declaration unwraps domain data and retains reviewed payload provenance", async () => {
  const { dir, binding } = await fixture(); await submit(dir, binding.prompt_sha256);
  const outcome = await ingestContractArtifacts(dir);
  expect(outcome.invalid).toEqual([]); expect(outcome.ingested).toContain("counterexample");
  const artifact = await readContractArtifact(dir, "counterexample");
  expect(artifact?.payload).toEqual(payload);
  expect(artifact?.review_provenance).toMatchObject({ requirement: "independent", prompt_sha256: binding.prompt_sha256, review: { mode: "independent" } });
  expect(artifact?.review_provenance?.reviewed_content_hash).toBe(artifact?.content_hash);
  expect(JSON.parse(await readFile(contractInputFilePath(dir, "counterexample"), "utf8"))).toHaveProperty("contract_version", "review-submission/v1");
});
test("raw, stale, unavailable and degraded independent submissions all fail closed", async () => {
  const { dir, binding } = await fixture();
  await writeFile(contractInputFilePath(dir, "counterexample"), JSON.stringify(payload));
  expect((await ingestContractArtifacts(dir)).invalid).toHaveLength(1);
  for (const [digest, mode] of [["0".repeat(64), "independent"], [binding.prompt_sha256, "degraded"], [binding.prompt_sha256, "unavailable"]]) {
    await submit(dir, digest!, mode);
    expect((await ingestContractArtifacts(dir)).invalid).toHaveLength(1);
  }
});
test("only explicit light critique/critic policy permits degradation; judge remains independent", async () => {
  expect(reviewRequirementForRole("critique", "light")).toBe("degraded_allowed");
  expect(reviewRequirementForRole("judge", "light")).toBe("independent");
  const { dir, binding } = await fixture("light"); await submit(dir, binding.prompt_sha256, "degraded");
  expect((await ingestContractArtifacts(dir, "light")).ingested).toContain("counterexample");
});
test("changed live dependencies refuse an old response before a new prompt is emitted", async () => {
  const { dir, binding } = await fixture(); await submit(dir, binding.prompt_sha256);
  await writeContractArtifact(dir, "goal_spec", { goal_id: "G2" });
  const result = await ingestContractArtifacts(dir);
  expect(result.stale).toContain("counterexample");
  expect(result.ingested).not.toContain("counterexample");
});
test("same task re-emission preserves an in-flight binding; changed context rotates it", async () => {
  const { dir, binding, requirement } = await fixture();
  const params = { artifactsDir: dir, artifact: "counterexample" as const, role: "critic", emissionId: "emit-two", requirement, prompt: "Review the bound module contracts." };
  await bindContractReviewPrompt(params);
  expect(JSON.parse(await readFile(contractReviewBindingPath(dir, "counterexample"), "utf8")).prompt_sha256).toBe(binding.prompt_sha256);
  await writeContractArtifact(dir, "goal_spec", { goal_id: "G2" }); await bindContractReviewPrompt(params);
  expect(JSON.parse(await readFile(contractReviewBindingPath(dir, "counterexample"), "utf8")).prompt_sha256).not.toBe(binding.prompt_sha256);
});
test("the envelope never bypasses domain validation or authorizes a swapped role", async () => {
  const { dir, binding, requirement } = await fixture(); await submit(dir, binding.prompt_sha256, "independent", {});
  expect((await ingestContractArtifacts(dir)).invalid).toHaveLength(1);
  await bindContractReviewPrompt({ artifactsDir: dir, artifact: "counterexample", role: "judge", emissionId: "other-role", requirement, prompt: "Judge something else" });
  await submit(dir, binding.prompt_sha256);
  expect((await ingestContractArtifacts(dir)).invalid[0]?.issues[0]?.message).toContain("role/policy binding");
});
test("mutating a canonical reviewed payload invalidates the retained receipt", async () => {
  const { dir, binding } = await fixture(); await submit(dir, binding.prompt_sha256); await ingestContractArtifacts(dir);
  const path = contractArtifactFilePath(dir, "counterexample");
  const canonical = JSON.parse(await readFile(path, "utf8")); canonical.payload.goal_id = "swapped";
  await writeFile(path, JSON.stringify(canonical));
  expect(await readContractArtifact(dir, "counterexample")).toBeNull();
});
test("canonical input reads and host submission output paths stay separate", () => {
  const paths = { goal_spec: "goal.input.json", finalized_module_contracts: "contracts.input.json", obligation_ledger: "ledger.input.json", cyclic_seam_resolution: "cycle.input.json", test_validator_plan: "tests.input.json", contract_assessment_report: "assessment.input.json", counterexample: "counterexample.input.json" };
  const rendered = renderContractPipelinePrompt({ role: "critic", artifactPaths: paths, artifactReadPaths: Object.fromEntries(Object.keys(paths).map(key => [key, `${key}.canonical.json`])) });
  expect(rendered.outputPath).toBe("counterexample.input.json");
  expect(rendered.prompt).toContain("goal_spec.canonical.json");
  expect(rendered.prompt).toContain("payload");
});

test("dependency verification hashes the actual payload rather than a stale stored header", async () => {
  const { dir, requirement } = await fixture();
  await writeContractArtifact(dir, "goal_spec", { goal_id: "before" });
  await bindContractReviewPrompt({ artifactsDir: dir, artifact: "counterexample", role: "critic", emissionId: "review-before", requirement, prompt: "Review actual content" });
  const binding = JSON.parse(await readFile(contractReviewBindingPath(dir, "counterexample"), "utf8"));
  await submit(dir, binding.prompt_sha256);
  const path = contractArtifactFilePath(dir, "goal_spec"); const canonical = JSON.parse(await readFile(path, "utf8"));
  canonical.payload.goal_id = "after"; await writeFile(path, JSON.stringify(canonical));
  const stale = await ingestContractArtifacts(dir);
  expect(stale.stale).toContain("counterexample");
  expect(stale.ingested).not.toContain("counterexample");
});
test("fresh artifact-tree lifecycle invalidates even an identical old review response", async () => {
  const { dir, binding, requirement } = await fixture();
  await rm(dir, { recursive: true, force: true });
  await bindContractReviewPrompt({ artifactsDir: dir, artifact: "counterexample", role: "critic", emissionId: "new-run-emission", requirement, prompt: "Review the bound module contracts." });
  const next = JSON.parse(await readFile(contractReviewBindingPath(dir, "counterexample"), "utf8"));
  expect(next.prompt_sha256).not.toBe(binding.prompt_sha256);
  await submit(dir, binding.prompt_sha256);
  expect((await ingestContractArtifacts(dir)).invalid[0]?.issues[0]?.message).toContain("stale or belongs to another lane");
});
