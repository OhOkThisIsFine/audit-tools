import { getArtifactsDir, hasFlag } from "./args.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";

export async function cmdCleanup(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");

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
