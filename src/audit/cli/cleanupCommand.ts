// sites-pinned: tests/audit/cleanup.test.ts, tests/audit/run-snapshot-ownership.test.ts
import { outputJson } from "./cliHelpers.js";
import { relative } from "node:path";
import { auditArtifactsDir } from "audit-tools/shared";
import { getArtifactsDir, getRootDir, hasFlag } from "./args.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";

function emitRefusal(
  artifactsDir: string,
  reason: string,
  dryRun: boolean,
): void {
  outputJson(
    {
      artifacts_dir: artifactsDir,
      action: "refused",
      reason,
      dry_run: dryRun,
    },
  );
  process.exitCode = 1;
}

export async function cmdCleanup(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");

  const root = getRootDir(argv);
  const custom = relative(auditArtifactsDir(root), artifactsDir) !== "";
  const result = await cleanupStaleArtifactsDir(artifactsDir, {
    force, dryRun, requireAuditMarker: true, repositoryRoot: root, explicitTarget: { custom, root },
  }).catch((error: unknown) => ({
    action: "refused" as const,
    reason: error instanceof Error ? error.message : String(error),
  }));

  if (result.action === "refused") {
    emitRefusal(artifactsDir, result.reason, dryRun);
    return;
  }

  if (result.action === "skipped") {
    outputJson(
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
    );
    process.exitCode = 1;
    return;
  }

  outputJson(
    {
      artifacts_dir: artifactsDir,
      action: result.action,
      status: result.status,
      dry_run: dryRun,
    },
  );
}
