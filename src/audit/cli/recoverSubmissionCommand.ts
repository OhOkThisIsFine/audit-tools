import { resolve } from "node:path";

import {
  readOptionalJsonFile,
  recoverSubmission,
  type SubmissionIssue,
} from "audit-tools/shared";

import { getArtifactsDir, getFlag } from "./args.js";
import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  laneSubmissionId,
  laneSubmissionRoots,
} from "./laneSubmissions.js";
import { laneSubmissionValidator } from "./laneValidators.js";

interface RepoManifestShape {
  readonly files?: readonly { readonly path?: unknown }[];
}

/**
 * The repo manifest's path set — the universe the charter lanes' scope
 * grounding is checked against. Degrades to empty rather than throwing: a
 * missing manifest makes the check STRICTER (every cited file is unknown),
 * never laxer, which is the safe direction for a rescue path.
 */
async function repoFileUniverse(artifactsDir: string): Promise<ReadonlySet<string>> {
  const manifest = await readOptionalJsonFile<RepoManifestShape>(
    resolve(artifactsDir, "repo_manifest.json"),
  ).catch(() => undefined);
  return new Set(
    (manifest?.files ?? [])
      .map((file) => file?.path)
      .filter((path): path is string => typeof path === "string"),
  );
}

/**
 * `audit-code recover-submission --lane <id> --from <path>` — re-land a
 * submission a host mangled.
 *
 * Deliberately the ONLY new verb P25 adds, and deliberately not on the normal
 * path: the ordinary lane needs no command at all (the host writes a file at a
 * tool-named path), so the fragile shell surface of an argv payload is paid only
 * on the rare rescue, by an operator at a terminal, never by a fan-out worker.
 *
 * It is not a weaker door. The validator comes from the same registry the gate
 * reads, the destination is derived from the lane id (so `--from` says what to
 * land, never where), and the rescue is recorded as `recovered_by_hand` rather
 * than passed off as a clean first-try result.
 */
export async function cmdRecoverSubmission(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const lane = getFlag(argv, "--lane") ?? getFlag(argv, "--submission-id");
  const fromPath = getFlag(argv, "--from");

  if (!lane || !fromPath) {
    throw new Error(
      "recover-submission requires --lane <id> and --from <path>. " +
        "The lane id is the one the step contract names; the destination is derived from it.",
    );
  }

  const validate = laneSubmissionValidator(lane, {
    repoFiles: await repoFileUniverse(artifactsDir),
  });
  if (validate === null) {
    // No contract to check against must never read as "passes".
    throw new Error(
      `Unknown submission lane: ${JSON.stringify(lane)}. ` +
        "Recovery refuses a lane it cannot validate.",
    );
  }

  // The gate's OWN roots, not the repo root: a rescued submission must report
  // the same bound path the gate derives and the expected set records. Taking
  // the repo root here made the reported path a different shape from the
  // recorded one, and — with an artifacts dir outside the repo — made the
  // report a throw after the payload had already landed.
  const roots = laneSubmissionRoots(artifactsDir);
  const outcome = await recoverSubmission(
    {
      root: roots.root,
      artifactsDir,
      runId: AUDIT_GATE_SUBMISSION_SCOPE,
      submissionId: laneSubmissionId(lane),
      fromPath: resolve(fromPath),
      lane,
      submissionDir: roots.submissionDir,
    },
    validate,
  );

  if (!outcome.ok) {
    const issue: SubmissionIssue = outcome.issue;
    throw new Error(
      `recover-submission refused the payload for lane '${lane}' (${issue.code}): ${issue.message}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "recovered",
        lane,
        submission_path: outcome.submission_path,
      },
      null,
      2,
    ),
  );
}
