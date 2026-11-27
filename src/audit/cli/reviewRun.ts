// sites-pinned: tests/audit-smoke.test.mjs
import { join } from "node:path";
import {
  isFileMissingError,
  readJsonFile,
} from "audit-tools/shared";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AuditState } from "../types/auditState.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  type AuditStopDisposition,
  CURRENT_TASK_FILENAME,
} from "../supervisor/operatorHandoff.js";
import { ActiveReviewRunSchema, type ActiveReviewRun } from "../contracts/wrapperResponse.js";
import { buildBlockedAuditState } from "./envelope.js";

function isActiveReviewRun(value: unknown): value is ActiveReviewRun {
  return ActiveReviewRunSchema.safeParse(value).success;
}

export async function loadCurrentActiveReviewRun(
  artifactsDir: string,
): Promise<ActiveReviewRun | null> {
  const path = join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME);
  try {
    const value = await readJsonFile<unknown>(path);
    if (!isActiveReviewRun(value)) {
      throw new Error(`Invalid audit review-run manifest: ${path}`);
    }
    return value;
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
}

export async function writeHandoffOnly(params: {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  audit_state: AuditState;
  progress_summary: string;
  stop?: AuditStopDisposition;
  activeReviewRun?: ActiveReviewRun;
}): Promise<void> {
  await writeAuditCodeHandoffArtifacts(
    buildAuditCodeHandoff({
      root: params.root,
      artifactsDir: params.artifactsDir,
      state: params.audit_state,
      bundle: params.bundle,
      progressSummary: params.progress_summary,
      stop: params.stop,
      activeReviewRun: params.activeReviewRun,
    }),
  );
}

export async function persistConfigErrorHandoff(params: {
  root: string;
  artifactsDir: string;
  progressSummary: string;
}): Promise<void> {
  await withArtifactTreeHold(params.artifactsDir, undefined, async () => {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    const blockedState = buildBlockedAuditState({
      state: bundle.audit_state ?? deriveAuditState(bundle),
      obligationId: null,
      executor: null,
      blocker: params.progressSummary,
    });
    const blockedBundle = { ...bundle, audit_state: blockedState };
    await writeCoreArtifacts(params.artifactsDir, blockedBundle);
    await writeHandoffOnly({
      root: params.root,
      artifactsDir: params.artifactsDir,
      bundle: blockedBundle,
      audit_state: blockedState,
      progress_summary: params.progressSummary,
      stop: { kind: "blocked" },
    });
  });
}
