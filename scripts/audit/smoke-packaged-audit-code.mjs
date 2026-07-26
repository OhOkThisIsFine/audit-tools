// Packaged smoke: install the packed tarball into a throwaway prefix, then run
// the whole audit flow through the installed bin. Flow + assertions live in
// ./smoke-audit-flow.mjs, shared with the linked smoke; this file owns only the
// packaged installation shape (tarball contract, isolated npm env).

import "../shared/hermetic-state-dir.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSmokeTarball } from "../shared/smoke-tarball.mjs";
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

const SMOKE_LABEL = "packaged";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageJsonPath = join(repoRoot, "package.json");
const packageVersion = JSON.parse(
  await readFile(packageJsonPath, "utf8"),
).version;
const requiredPackagedPaths = [
  "audit-code.mjs",
  "wrapper/audit-code-wrapper-lib.mjs",
  "package.json",
  "README.md",
  "dist/audit/index.js",
  "dist/audit/cli.js",
  "dispatch/lens-definitions.json",
  "schemas/audit_result.schema.json",
  "skills/audit-code/SKILL.md",
  "skills/audit-code/agents/openai.yaml",
  "skills/audit-code/audit-code.prompt.md",
];
const verbose = process.env.AUDIT_CODE_VERBOSE === "1";
const liveCommandOutput = true;

const log = createSmokeLog(SMOKE_LABEL);
const runCommand = createRunCommand({ smokeLabel: SMOKE_LABEL, defaultCwd: repoRoot });

function installedAuditCodeCommand(installDir) {
  return process.platform === "win32"
    ? join(installDir, "node_modules", ".bin", "audit-code.cmd")
    : join(installDir, "node_modules", ".bin", "audit-code");
}

function installedDistCliPath(installDir) {
  return join(installDir, "node_modules", "audit-tools", "dist", "audit", "cli.js");
}

// `npm publish --dry-run` can leak dry-run flags, registry overrides, and auth
// tokens into child npm invocations. The packaged smoke flow needs a real
// tarball and a clean install, so we intentionally strip npm_config_* overrides
// plus publish credentials before forcing dry-run back off.
function createIsolatedNpmEnv(env = process.env) {
  const nextEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("npm_config_") ||
      normalizedKey === "node_auth_token" ||
      normalizedKey === "npm_token"
    ) {
      continue;
    }
    nextEnv[key] = value;
  }
  // Explicitly force dry-run off in case npm reads it from another source.
  nextEnv.npm_config_dry_run = "false";
  nextEnv.NPM_CONFIG_DRY_RUN = "false";
  nextEnv.NPM_CONFIG_LOGLEVEL = env.NPM_CONFIG_LOGLEVEL ?? (verbose ? "notice" : "warn");
  return nextEnv;
}

function assertPackagedContract(packMetadata) {
  assert.equal(
    Array.isArray(packMetadata.files),
    true,
    "npm pack --json did not return a tarball file list.",
  );
  const packagedPaths = new Set(packMetadata.files.map((entry) => entry.path));
  const missingPaths = requiredPackagedPaths.filter(
    (requiredPath) => !packagedPaths.has(requiredPath),
  );

  if (missingPaths.length > 0) {
    throw new Error(
      `Packed tarball ${packMetadata.filename ?? "(unknown filename)"} is missing required shipped paths: ${missingPaths.join(", ")}. Rerun npm run build and npm pack --dry-run to inspect the packaged file list before retrying the smoke script.`,
    );
  }
}

async function main() {
  const smokeStart = Date.now();
  let stepStart = Date.now();
  log.step("start");
  const installDir = await mkdtemp(join(tmpdir(), "audit-code-packed-install-"));

  try {
    await writeFile(
      join(installDir, "package.json"),
      JSON.stringify(
        {
          name: "audit-code-packed-install-smoke",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
    );

    stepStart = Date.now();
    log.step("resolve packaged tarball");
    // One tarball serves both packaged smokes (scripts/shared/smoke-tarball.mjs): the
    // shared pack step produces it, this smoke reuses it while it is still current and
    // packs for itself otherwise, so a standalone run never depends on gate order.
    const { tarballPath, metadata: packMetadata, packed } = resolveSmokeTarball();
    const tarballFilename = packMetadata.filename;
    assertPackagedContract(packMetadata);
    log.detail(`${packed ? "packed" : "reused"} ${tarballPath}`);
    log.elapsed("resolve packaged tarball", stepStart);

    stepStart = Date.now();
    log.step("npm install from tarball");
    await runCommand(
      platformCommand("npm"),
      ["install", "--no-package-lock", tarballPath],
      {
        cwd: installDir,
        env: createIsolatedNpmEnv(),
        liveOutput: liveCommandOutput,
        label: "npm install --no-package-lock <tarball>",
        failureHint:
          "Confirm the tarball exists on disk, the inherited npm publish env was stripped, and rerun with AUDIT_CODE_VERBOSE=1 if the install stalls or the registry config looks wrong.",
      },
    );
    const auditCodeCommand = installedAuditCodeCommand(installDir);
    const packagedPromptPath = join(
      installDir,
      "node_modules",
      "audit-tools",
      "skills",
      "audit-code",
      "audit-code.prompt.md",
    );
    log.elapsed("npm install from tarball", stepStart);

    stepStart = Date.now();
    log.step("prompt-path check");
    const promptPathOutput = (
      await runCommand(auditCodeCommand, ["prompt-path"], { cwd: installDir })
    ).stdout.trim();
    assert.equal(promptPathOutput, packagedPromptPath);
    assert.equal((await stat(promptPathOutput)).isFile(), true);
    assert.match(await readFile(promptPathOutput, "utf8"), /\/audit-code/);
    log.elapsed("prompt-path check", stepStart);

    stepStart = Date.now();
    log.step("--version check");
    const versionOutput = (
      await runCommand(auditCodeCommand, ["--version"], { cwd: installDir })
    ).stdout.trim();
    assert.equal(versionOutput, packageVersion);
    log.elapsed("--version check", stepStart);

    await withTempRepo("audit-code-packaged-smoke-", async (root) => {
      await runEnsurePhase({ runCommand, auditCodeCommand, root, log });
      await runInstallPhase({
        runCommand,
        auditCodeCommand,
        root,
        log,
        expectedPromptSourcePath: packagedPromptPath,
      });
      await runAuditFlowPhase({
        runCommand,
        auditCodeCommand,
        root,
        log,
        smokeLabel: SMOKE_LABEL,
        distCliPath: installedDistCliPath(installDir),
      });
    });

    log.success(
      `Validated tarball ${tarballFilename}, packaged install bootstrap surfaces, and the next-step/ingest-results/present_report audit flow. Total elapsed: ${Math.round((Date.now() - smokeStart) / 1000)}s.`,
    );
  } finally {
    // The tarball is deliberately left in the shared pack cache — it is the artifact
    // the sibling packaged smoke installs, and it lives outside the repo.
    await rm(installDir, { recursive: true, force: true });
  }
}

await main();
