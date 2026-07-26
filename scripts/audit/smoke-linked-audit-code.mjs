// Linked smoke: `npm link` this checkout, then run the whole audit flow through
// the global bin. Flow + assertions live in ./smoke-audit-flow.mjs, shared with
// the packaged smoke; this file owns only the linked installation shape.

import "../shared/hermetic-state-dir.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRunCommand,
  createSmokeLog,
  platformCommand,
} from "../shared/smoke-process.mjs";
import {
  runAuditFlowPhase,
  runEnsurePhase,
  runInstallPhase,
  withTempRepo,
} from "./smoke-audit-flow.mjs";

const SMOKE_LABEL = "linked";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distCliPath = join(repoRoot, "dist", "audit", "cli.js");
const packageJsonPath = join(repoRoot, "package.json");
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;
const liveCommandOutput = true;

const log = createSmokeLog(SMOKE_LABEL);
const runCommand = createRunCommand({ smokeLabel: SMOKE_LABEL, defaultCwd: repoRoot });

async function main() {
  const smokeStart = Date.now();
  let stepStart = Date.now();
  log.step("npm link");
  await runCommand(platformCommand("npm"), ["link"], {
    cwd: repoRoot,
    liveOutput: liveCommandOutput,
    label: "npm link",
    failureHint:
      "Confirm the repository builds locally and that npm link has permission to create the global symlink for this user.",
  });
  log.elapsed("npm link", stepStart);
  const auditCodeCommand = platformCommand("audit-code");

  stepStart = Date.now();
  log.step("--version check");
  const versionOutput = (
    await runCommand(auditCodeCommand, ["--version"], {
      label: "audit-code --version",
      failureHint:
        "Confirm npm link completed successfully and that the linked audit-code binary is on PATH before retrying.",
    })
  ).stdout.trim();
  assert.equal(versionOutput, packageVersion);
  log.elapsed("--version check", stepStart);

  await withTempRepo("audit-code-smoke-", async (root) => {
    await runEnsurePhase({ runCommand, auditCodeCommand, root, log });
    await runInstallPhase({
      runCommand,
      auditCodeCommand,
      root,
      log,
      expectedPromptSourcePath: join(
        repoRoot,
        "skills",
        "audit-code",
        "audit-code.prompt.md",
      ),
    });
    await runAuditFlowPhase({
      runCommand,
      auditCodeCommand,
      root,
      log,
      smokeLabel: SMOKE_LABEL,
      distCliPath,
    });
  });

  log.success(
    `Validated npm link installation, linked host bootstrap surfaces, and the next-step/ingest-results/present_report audit flow. Total elapsed: ${Math.round((Date.now() - smokeStart) / 1000)}s.`,
  );
}

// Remove the global `npm link` this smoke creates. Leaving it behind is a real
// footgun: when this checkout (often an ephemeral git worktree) is later
// removed, the global `audit-tools` package junction dangles and every
// global `audit-code` invocation dies with a raw MODULE_NOT_FOUND. Always clean
// up — even when the smoke fails partway — and never let cleanup failure mask
// the smoke's own result.
async function removeGlobalLink() {
  await runCommand(platformCommand("npm"), ["rm", "--global", "audit-tools"], {
    cwd: repoRoot,
    label: "npm unlink (cleanup)",
    failureHint:
      "Run `npm rm --global audit-tools` to remove the smoke test's global link.",
  }).catch((error) => {
    log.warning(
      "could not remove the global link; run `npm rm --global audit-tools` manually: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

try {
  await main();
} finally {
  await removeGlobalLink();
}
