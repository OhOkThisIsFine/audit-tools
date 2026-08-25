import { existsSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import { AUDIT_TOOLS_DIRNAME, auditArtifactsDir } from "audit-tools/shared";
import { getArtifactsDir, hasFlag } from "./args.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";

// The structural identity of an audit artifacts directory, which the `cleanup`
// verb has to PROVE a target carries before recursively deleting it
// (CP-NODE-16). Both segments come from the single-sourced layout in
// audit-tools/shared (src/shared/io/auditToolsPaths.ts): the dirname constant
// directly, the area segment derived from the helper that builds it — so a
// layout change moves this guard with it instead of silently disarming it.
const AUDIT_AREA_DIRNAME = basename(auditArtifactsDir("."));
// The supervisor state marker; audit-tools/shared exposes no constant for it yet
// (the literal is spelled at every producer/consumer site), so it is named here.
const AUDIT_STATE_FILENAME = "audit_state.json";

export type CleanupTargetValidation =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Validate the cleanup TARGET itself — a purely structural check, independent
 * of audit state, flags, and eligibility (CP-NODE-16). `--force` overrides the
 * interactive/status confirmation inside cleanupStaleArtifactsDir; it must
 * never override this: a mistyped or overly broad `--artifacts-dir` (`.`, a
 * checkout root, a filesystem root) reaching a recursive rm is exactly the
 * accident this verb has to make impossible.
 *
 * Two rules:
 *   1. the path must BE an artifacts dir — `<X>/.audit-tools/audit`, never a
 *      filesystem root — decided from the path shape alone, so it holds even
 *      when the directory does not exist yet;
 *   2. `--force` additionally requires the `audit_state.json` marker on disk:
 *      force waives the STATUS evidence, never the IDENTITY evidence. Without
 *      `--force` a missing marker changes nothing — the eligibility gate in
 *      cleanupStaleArtifactsDir already refuses to delete, so the verb's
 *      skipped / crashed-audit contract is untouched.
 */
export function validateCleanupTarget(
  artifactsDir: string,
): CleanupTargetValidation {
  const resolved = resolve(artifactsDir);

  if (resolved === parse(resolved).root) {
    return {
      ok: false,
      reason: `refusing to delete ${resolved}: it is a filesystem root, not an ${AUDIT_TOOLS_DIRNAME}/${AUDIT_AREA_DIRNAME} artifacts directory`,
    };
  }

  if (
    basename(resolved) !== AUDIT_AREA_DIRNAME ||
    basename(dirname(resolved)) !== AUDIT_TOOLS_DIRNAME
  ) {
    return {
      ok: false,
      reason: `refusing to delete ${resolved}: not an ${AUDIT_TOOLS_DIRNAME}/${AUDIT_AREA_DIRNAME} artifacts directory — pass --artifacts-dir pointing at the audit artifacts dir`,
    };
  }

  return { ok: true };
}

function emitRefusal(
  artifactsDir: string,
  reason: string,
  dryRun: boolean,
): void {
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        action: "refused",
        reason,
        dry_run: dryRun,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}

export async function cmdCleanup(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");

  // Target validation precedes EVERY recursive-delete path (CP-NODE-16):
  // --force relaxes the status confirmation only, never the structural check.
  const validation = validateCleanupTarget(artifactsDir);
  if (!validation.ok) {
    emitRefusal(artifactsDir, validation.reason, dryRun);
    return;
  }
  const markerPath = resolve(artifactsDir, AUDIT_STATE_FILENAME);
  if (force && !existsSync(markerPath)) {
    emitRefusal(
      artifactsDir,
      `--force given, but ${markerPath} does not exist — the directory carries no audit_state.json marker, so it is not provably an audit artifacts dir; refusing to delete`,
      dryRun,
    );
    return;
  }

  const result = await cleanupStaleArtifactsDir(artifactsDir, { force, dryRun });

  if (result.action === "skipped") {
    console.log(
      JSON.stringify(
        {
          artifacts_dir: artifactsDir,
          action: "skipped",
          // Do NOT advise --force here. This fallback covers the
          // status="unknown" branch — a directory with no audit_state.json
          // marker — and that is the one case --force does NOT waive: the
          // marker check above refuses a forced delete outright. Force waives
          // the run's STATUS evidence, never its IDENTITY evidence.
          reason:
            result.reason ??
            "no audit_state.json found — the directory carries no audit-run marker, so it is not provably an audit artifacts dir; --force does not waive this (force waives run STATUS evidence, never IDENTITY evidence)",
          dry_run: dryRun,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        action: result.action,
        status: result.status,
        dry_run: dryRun,
      },
      null,
      2,
    ),
  );
}
