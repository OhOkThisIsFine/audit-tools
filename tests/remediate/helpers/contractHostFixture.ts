import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { bindContractReviewPrompt, contractReviewBindingPath, validateContractReviewInput } from "../../../src/remediate/contractPipeline/contractReviewBinding.js";
import { PHASE_TO_ARTIFACT, renderContractPipelinePrompt, reviewRequirementForRole } from "../../../src/remediate/steps/contractPipelinePrompts.js";
import { ingestContractArtifacts, resolveAdversarialDepth } from "../../../src/remediate/steps/contractPipeline.js";
import { CP_ARTIFACT_NAMES, contractArtifactFilePath, contractInputFilePath, type ContractPipelineArtifactName } from "../../../src/remediate/contractPipeline/artifactStore.js";

/** Author fixture payloads through the real review binding when the role requires one. */
export async function writeContractHostFixture(
  options: { root: string; artifactsDir: string; runId: string },
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  const { root, artifactsDir, runId } = options;
  const path = contractInputFilePath(artifactsDir, name);
  await mkdir(dirname(path), { recursive: true });
  const role = Object.entries(PHASE_TO_ARTIFACT).find(([, artifact]) => artifact === name)?.[0] ?? "";
  const depth = (await resolveAdversarialDepth(artifactsDir)).adversarialDepth;
  const requirement = reviewRequirementForRole(role, depth);
  let submitted = payload;
  if (requirement !== "ordinary") {
    // Domain fixtures author upstreams in batches. Settle those real submissions
    // before minting a review of their actual canonical content.
    await ingestContractArtifacts(artifactsDir, depth);
    let binding: { prompt_sha256: string } | undefined;
    try { binding = JSON.parse(await readFile(contractReviewBindingPath(artifactsDir, name), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const wrap = (digest: string) => ({ contract_version: "review-submission/v1", prompt_sha256: digest,
      review: { mode: "independent", reason: "Fixture simulates the independent review context" }, result: payload });
    const current = binding && await validateContractReviewInput({ artifactsDir: artifactsDir, artifact: name, role, requirement, raw: wrap(binding.prompt_sha256) });
    if (!current?.ok) {
      const artifactPaths = Object.fromEntries(CP_ARTIFACT_NAMES.map(artifact => [artifact, contractInputFilePath(artifactsDir, artifact)]));
      const artifactReadPaths = Object.fromEntries(CP_ARTIFACT_NAMES.map(artifact => [artifact, contractArtifactFilePath(artifactsDir, artifact)]));
      const rendered = renderContractPipelinePrompt({ role, artifactPaths, artifactReadPaths, repoRoot: root, adversarialDepth: depth });
      await bindContractReviewPrompt({ artifactsDir: artifactsDir, artifact: name, role, emissionId: runId, requirement, prompt: rendered.prompt });
      binding = JSON.parse(await readFile(contractReviewBindingPath(artifactsDir, name), "utf8"));
    }
    submitted = wrap(binding!.prompt_sha256);
  }
  await writeFile(path, JSON.stringify(submitted, null, 2) + "\n", "utf8");
}
