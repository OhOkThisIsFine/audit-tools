// sites-pinned: tests/remediate/contract-review-independence.test.ts, tests/remediate/contract-pipeline-adversarial.test.ts
import { join } from "node:path";
import { z } from "zod";
import { bindWorkerPrompt } from "../../shared/submission/workerPromptBinding.js";
import { writeJsonFile } from "../../shared/io/json.js";
import { readSubmissionDocument } from "../../shared/submission/submissionClassifier.js";
import { hashContent } from "../../shared/hash.js";
import { stableStringify } from "../../shared/stableStringify.js";
import { ReviewRequirementSchema, parseReviewSubmissionEnvelope, type ReviewRequirement, type ReviewSubmissionFailureCode, type ContractReviewDeclaration } from "../../shared/types/reviewIndependence.js";
import { DEPENDENCY_MAP, contractPipelineDir, readContractArtifact, type ContractPipelineArtifactName } from "./artifactStore.js";

const BindingSchema = z.object({
  contract_version: z.literal("contract-review-binding/v1"),
  artifact_name: z.string(),
  role: z.string(),
  emission_id: z.string(),
  requirement: ReviewRequirementSchema,
  prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  source_prompt_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dependency_hashes: z.record(z.string(), z.string().nullable()),
}).strict();

export function contractReviewBindingPath(artifactsDir: string, name: ContractPipelineArtifactName): string {
  return join(contractPipelineDir(artifactsDir), `${name}.review-binding.json`);
}

async function dependencyHashes(artifactsDir: string, name: ContractPipelineArtifactName): Promise<Record<string, string | null>> {
  const pairs = await Promise.all(DEPENDENCY_MAP[name].map(async dep => [dep, (await readContractArtifact(artifactsDir, dep))?.content_hash ?? null] as const));
  return Object.fromEntries(pairs);
}

/** Tool-owned expectation, separate from the worker's declared review envelope. */
export async function bindContractReviewPrompt(params: {
  artifactsDir: string; artifact: ContractPipelineArtifactName; role: string;
  emissionId: string; requirement: ReviewRequirement; prompt: string;
}): Promise<string> {
  if (params.requirement === "ordinary") return params.prompt;
  const dependencies = await dependencyHashes(params.artifactsDir, params.artifact);
  const sourcePromptHash = hashContent(params.prompt);
  const priorRead = await readSubmissionDocument(contractReviewBindingPath(params.artifactsDir, params.artifact));
  const prior = BindingSchema.safeParse(priorRead.kind === "value" ? priorRead.value : undefined);
  const sameTask = prior.success && prior.data.artifact_name === params.artifact && prior.data.role === params.role &&
    prior.data.requirement === params.requirement && prior.data.source_prompt_sha256 === sourcePromptHash &&
    stableStringify(prior.data.dependency_hashes) === stableStringify(dependencies);
  const emissionId = sameTask ? prior.data.emission_id : params.emissionId;
  const context = { artifact_name: params.artifact, role: params.role, emission_id: emissionId, requirement: params.requirement, dependency_hashes: dependencies };
  const body = `${params.prompt}\n\n## Bound review submission\n\nThe domain schema above is the inner result. Submit the complete review envelope below to the named output path, not a raw artifact.\nReview context: ${stableStringify(context)}`;
  const bound = bindWorkerPrompt(body, prompt_sha256 => [
    "```json",
    JSON.stringify({ contract_version: "review-submission/v1", prompt_sha256,
      review: { mode: params.requirement === "degraded_allowed" ? "degraded" : "independent", reason: "<how the review context meets the required policy>" },
      result: { "<artifact fields>": "<complete domain object using the schema above>" },
    }, null, 2),
    "```",
    "If the required review context is unavailable, declare mode unavailable with the reason. Do not silently replace required independent review with self-review.",
  ].join("\n"));
  await writeJsonFile(contractReviewBindingPath(params.artifactsDir, params.artifact), {
    contract_version: "contract-review-binding/v1", ...context, prompt_sha256: bound.sha256, source_prompt_sha256: sourcePromptHash,
  });
  return bound.text;
}

export async function validateContractReviewInput(params: {
  artifactsDir: string; artifact: ContractPipelineArtifactName; role: string;
  requirement: ReviewRequirement; raw: unknown;
}): Promise<{ ok: true; payload: unknown; provenance?: ContractReviewDeclaration } | { ok: false; issue: string; code: ReviewSubmissionFailureCode | "dependency_stale" }> {
  if (params.requirement === "ordinary") return { ok: true, payload: params.raw };
  const read = await readSubmissionDocument(contractReviewBindingPath(params.artifactsDir, params.artifact));
  const parsed = BindingSchema.safeParse(read.kind === "value" ? read.value : undefined);
  if (!parsed.success || parsed.data.artifact_name !== params.artifact || parsed.data.role !== params.role || parsed.data.requirement !== params.requirement) {
    return { ok: false, code: "binding_missing", issue: "This required review has no current tool-issued role/policy binding. Re-emit the role and use its bound review-submission/v1 envelope." };
  }
  const binding = parsed.data;
  if (stableStringify(binding.dependency_hashes) !== stableStringify(await dependencyHashes(params.artifactsDir, params.artifact))) {
    return { ok: false, code: "dependency_stale", issue: "The inputs reviewed by this submission have changed. Re-emit the review against the current dependency content before accepting it." };
  }
  const submission = parseReviewSubmissionEnvelope(params.raw, { requirement: params.requirement, promptSha256: binding.prompt_sha256 });
  if (!submission.ok) return submission;
  return { ok: true, payload: submission.result, provenance: {
    requirement: params.requirement, prompt_sha256: binding.prompt_sha256, review: submission.review!,
  } };
}
