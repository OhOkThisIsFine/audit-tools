import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { explicitScopeExclusion, firstDispositionOverride } from "../../shared/intent/pathScope.js";
import type { FileDisposition } from "../../shared/types/disposition.js";
import type { IntentCheckpoint } from "../../shared/types/intentCheckpoint.js";
import type { RepoManifest } from "../types.js";
import type { AuditScopeManifest } from "../types/auditScope.js";

interface ReviewSourceArtifacts {
  repo_manifest?: RepoManifest;
  file_disposition?: FileDisposition;
  intent_checkpoint?: IntentCheckpoint;
  scope?: AuditScopeManifest;
}

/** Same trust boundary for planner references and the full allowed review scope. */
export function reviewSourceScope(bundle: ReviewSourceArtifacts, overrideScope?: AuditScopeManifest) {
  const files = new Map(bundle.repo_manifest?.files.map((file) => [file.path, file]));
  const dispositions = new Map(bundle.file_disposition?.files.map((file) => [file.path, file]));
  const intent = bundle.intent_checkpoint;
  const scope = overrideScope ?? bundle.scope;
  const delta = scope?.mode === "delta" ? new Set([...scope.seed_files, ...scope.expanded_files]) : undefined;
  const sourceStatus = (path: string, contract = false, requireFingerprint = true): string | undefined => {
    const exclusion = explicitScopeExclusion(path, intent);
    if (exclusion) return exclusion.reason;
    const file = files.get(path);
    if (!file) return "No unique frozen source file was resolved for this surface.";
    if (file.excluded) return file.exclusion_reason ?? "Outside the admitted audit source.";
    const override = firstDispositionOverride(path, intent);
    const disposition = override ?? dispositions.get(path);
    const contractDocument = contract && disposition?.status === "doc_only";
    if (disposition?.status !== "included" && !contractDocument) {
      return disposition?.reason ?? (disposition ? `Source disposition: ${disposition.status}.` : "Source disposition has not been established.");
    }
    if (delta && !contractDocument && !delta.has(path)) return "Outside the confirmed changed scope.";
    if (requireFingerprint && !file.hash) return "Source is present but lacks a verifiable content fingerprint.";
    return undefined;
  };
  const paths = [...files.keys()].sort(compareCodeUnits);
  return {
    files, dispositions, sourceStatus,
    emptySourcePaths: new Set([...files.values()].filter(file => file.size_bytes === 0 && file.hash).map(file => file.path)),
    includedSourcePaths: paths.filter(path => sourceStatus(path, false, false) === undefined),
    allowedSourcePaths: paths.filter(path => sourceStatus(path) === undefined),
    allowedContractPaths: paths.filter(path => sourceStatus(path, true) === undefined),
  };
}
