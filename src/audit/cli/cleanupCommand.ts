import { existsSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import { getArtifactsDir, hasFlag } from "./args.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";

// The structural identity of an audit artifacts directory, spelled here because
// the `cleanup` verb is the component that has to PROVE a target looks like one
// before recursively deleting it (CP-NODE-16). These mirror the layout literals
// `auditArtifactsDir` builds from in audit-tools/shared; they are restated
// locally because the shared subpath export does not re-export them and the
// guard below must stay decidable from this file alone.
const AUDIT_TOOLS_DIRNAME = ".audit-tools";
const AUDIT_AREA_DIRNAME = "audit";
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
          reason: result.reason ?? "no audit_state.json found; artifacts may be from a crashed audit — use --force to delete anyway",
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
