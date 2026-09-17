// sites-pinned: tests/audit/recover-submission-mis-route.test.ts, tests/shared/hand-recovery-uses-the-same-validator.test.ts
//   The first suite drives this verb's own mis-route guard through the CLI; the
//   second pins that the rescue path validates through the same gate the normal
//   path uses, so a divergence here reds one of the two.
import { resolve } from "node:path";

import {
  CHARTER_PACKET_MANIFEST_SCHEMA_VERSION,
  CharterLaneSubmissionSchema,
  PATH_SHAPED_PROVENANCE_KINDS,
  laneAssetsDir,
  provenancePath,
  readOptionalJsonFile,
  recoverSubmission,
  type CharterKind,
  type CharterPacketManifest,
  type SubmissionIssue,
} from "audit-tools/shared";

import { getArtifactsDir, getFlag } from "./args.js";
import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  charterExtractionCoverageFilename,
  charterKindForLane,
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
 * The source paths the named extraction lane's evidence packet actually
 * delivered, or `undefined` when the packet manifest is absent.
 *
 * The manifest is written by the EMIT pass, so its absence means no charter
 * packet was ever handed to that lane and there is nothing to rescue a
 * submission INTO. That is reported as a refusal rather than an abstention: see
 * `charterMisRouteIssue`.
 */
async function laneDeliveredPaths(
  artifactsDir: string,
  kind: CharterKind,
): Promise<ReadonlySet<string> | undefined> {
  const manifest = await readOptionalJsonFile<CharterPacketManifest>(
    resolve(laneAssetsDir(artifactsDir), charterExtractionCoverageFilename(kind)),
  ).catch(() => undefined);
  if (manifest?.schema_version !== CHARTER_PACKET_MANIFEST_SCHEMA_VERSION) {
    return undefined;
  }
  return new Set(manifest.excerpts.map((excerpt) => excerpt.source_path));
}

/**
 * Refuse a rescued extraction payload whose citations could not have come from
 * THIS lane's evidence packet.
 *
 * Why this guard exists at all. The submission stated its own `kind` until
 * 2026-09-17, and that field doubled as a mis-route detector: a payload landed on
 * the wrong lane announced itself. The field is gone — the tool resolves the kind
 * from the bound path — and the normal path loses nothing, because a lane never
 * chooses its own destination there. This verb does: `--from` names arbitrary
 * content and `--lane` names the destination, so it is the one door through which
 * one channel's goals can be attributed to another. A wrongly attributed lane is
 * silent and corrupts every downstream comparison; it passed 5448 tests when it
 * was measured.
 *
 * What replaces the field is WEAKER, and deliberately so — there is no declared
 * kind left to compare, so the channel has to be inferred from content. The one
 * honest inference is the property the prompt already states: each lane's packet
 * is SUFFICIENT, so an obedient lane cites only what its own packet delivered.
 * A payload authored against a different packet therefore cites paths this lane
 * was never handed. That catches a cross-lane mis-route; it does NOT catch a
 * payload whose citations happen to fall inside the overlap of two packets, and
 * it is not a purity claim.
 *
 * A missing manifest REFUSES rather than abstains. Unlike the repo manifest above
 * — whose absence only makes scope grounding stricter — a missing packet manifest
 * means the emit pass never handed this lane a packet, so there is no lane to
 * rescue a submission onto.
 */
function charterMisRouteIssue(
  lane: string,
  kind: CharterKind,
  delivered: ReadonlySet<string> | undefined,
  value: unknown,
): SubmissionIssue | null {
  if (delivered === undefined) {
    return {
      code: "submission_contract_invalid",
      message:
        `lane '${lane}' has no evidence packet manifest under ${laneAssetsDir("<artifacts>")} — ` +
        "the emit pass never handed this lane a packet, so a submission cannot be " +
        "attributed to it. Re-run the emitting step, then rescue the payload.",
    };
  }
  const parsed = CharterLaneSubmissionSchema.safeParse(value);
  if (!parsed.success) return null; // The schema validator already owns this refusal.
  const refs = [
    ...parsed.data.nodes.flatMap((node) => node.provenance),
    ...parsed.data.edges.flatMap((edge) => edge.provenance),
  ]
    .filter((provenance) => PATH_SHAPED_PROVENANCE_KINDS.has(provenance.kind))
    .map((provenance) => provenancePath(provenance.ref));
  const foreign = [...new Set(refs.filter((path) => !delivered.has(path)))].sort();
  if (foreign.length === 0) return null;
  return {
    code: "submission_contract_invalid",
    message:
      `this payload cites ${foreign.length} path(s) the '${kind}' lane's evidence packet never ` +
      `delivered: ${foreign.join(", ")} — each lane's packet is sufficient for its own goals, so a ` +
      "payload citing outside it was authored against a different lane. Check --lane against --from.",
  };
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

  const schemaValidate = laneSubmissionValidator(lane, {
    repoFiles: await repoFileUniverse(artifactsDir),
  });
  if (schemaValidate === null) {
    // No contract to check against must never read as "passes".
    throw new Error(
      `Unknown submission lane: ${JSON.stringify(lane)}. ` +
        "Recovery refuses a lane it cannot validate.",
    );
  }

  // An extraction lane carries one rule the gate does not: the mis-route check
  // this verb's own `--from` makes reachable. See `charterMisRouteIssue`.
  const kind = charterKindForLane(lane);
  const validate: (value: unknown) => SubmissionIssue | null =
    kind === undefined
      ? schemaValidate
      : await (async () => {
          const delivered = await laneDeliveredPaths(artifactsDir, kind);
          return (value: unknown) =>
            schemaValidate(value) ?? charterMisRouteIssue(lane, kind, delivered, value);
        })();

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
