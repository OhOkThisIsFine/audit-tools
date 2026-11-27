import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureQuestionReviewRunIdUnlocked } from "../../../src/audit/cli/questionReviewSession.js";
import { deriveCurrentQuestionBindings } from "../../../src/audit/cli/questionReviewCycle.js";
import { publishAuditQuestionWorkload } from "../../../src/audit/cli/dispatch/hostHandoff.js";
import { buildGraphBundle } from "../../../src/audit/extractors/graph.js";
import { ensureRunSourceRoot } from "../../../src/audit/io/runSnapshot.js";
import { writeCoreArtifacts, type ArtifactBundle } from "../../../src/audit/io/artifacts.js";
import { hashContent } from "../../../src/shared/hash.js";
import { REVIEW_QUESTION_CONTRACT_VERSION } from "../../../src/shared/types/reviewQuestion.js";

const sources = {
  "src/manual.ts": "export const manual = true;\n",
  "src/scheduled.ts": "export const scheduled = true;\n",
  "src/neighbor/helper.ts": "export const value = 1;\n",
  "src/neighbor/isolated.ts": "import { value } from './helper.js';\nexport const unrelated = value;\n",
};

/** Real frozen source, plan bindings, and publication; no upstream audit prelude. */
export async function issueReviewFixture(root: string, artifactsDir = join(root, ".audit-tools", "audit")) {
  const files = await Promise.all(Object.entries(sources).map(async ([path, source]) => {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, source);
    return { path, language: "ts", size_bytes: Buffer.byteLength(source), hash: hashContent(source) };
  }));
  await mkdir(artifactsDir, { recursive: true });
  const sourceRoot = await ensureRunSourceRoot(root, artifactsDir);
  const runId = await ensureQuestionReviewRunIdUnlocked(artifactsDir);
  const parts = ["manual", "scheduled"] as const;
  const snapshotId = "frozen-issue-fixture";
  const bundle: ArtifactBundle = {
    repo_manifest: { repository: { name: "issued review fixture" }, generated_at: "2026-11-27T00:00:00Z", files },
    file_disposition: { files: files.map(({ path }) => ({ path, status: "included" })) },
    review_plan: {
      schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
      snapshot_id: snapshotId,
      inventory: parts.map(part => ({
        inventory_item_id: part, kind: "operation", title: part,
        source_refs: [{ path: "src/" + part + ".ts" }], contract_refs: [], scope: "in_scope",
      })),
      questions: parts.map(part => {
        const path = "src/" + part + ".ts";
        return {
          schema_version: REVIEW_QUESTION_CONTRACT_VERSION,
          question_id: part, revision_id: "r1", snapshot_id: snapshotId, lens: "behavior",
          inventory_item_ids: [part], expected_outcome: "Retain unfinished work",
          requested_parts: [{ part_id: part, expectation: "Retain unfinished work" }],
          source_dependencies: [{ kind: "source", key: path, fingerprint: files.find(file => file.path === path)!.hash }],
          evidence_dependencies: [], plan_status: "pending",
        };
      }),
      lens_decisions: [], omissions: [],
    },
  };
  await writeCoreArtifacts(artifactsDir, bundle);
  const { bindings } = await deriveCurrentQuestionBindings(bundle, sourceRoot);
  const graph = buildGraphBundle(bundle.repo_manifest!, bundle.file_disposition, { fileContents: sources });
  return { artifactsDir, runId, ...await publishAuditQuestionWorkload({ root, artifactsDir, runId, sourceRoot, bindings, graph }) };
}
