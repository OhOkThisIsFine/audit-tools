#!/usr/bin/env node
// Single-package postinstall: deploy BOTH the audit-code and remediate-code host
// assets (global slash commands, Codex/OpenCode/Antigravity skills, plugin
// manifests). Each sub-deployer is self-contained — it computes its own package
// root, skips optional steps when the shared dist isn't built yet (fresh `npm ci`),
// and exits non-zero only on a real partial-deploy failure (e.g. a blocked write
// target). We run both as isolated child processes so one host's deployment never
// corrupts the other's, and surface a non-zero exit if EITHER reports a failure
// (INV-remediate-infra-08: a partial deploy must not report success).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
let failed = false;

// A published tarball already carries dist/. A source checkout does not, and
// npm's postinstall runs only after dependencies are present, so this is the
// first reliable point at which it can build the shared export. Without this
// bootstrap a fresh checkout partially deployed host assets and skipped both
// OpenCode config and artifact .gitignore management until a human happened to
// rerun postinstall after the first build.
if (!ensureSourceCheckoutBuilt()) failed = true;

for (const script of ["./audit/postinstall.mjs", "./remediate/postinstall.mjs"]) {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit", windowsHide: true });
  if (result.error) {
    console.warn(`[audit-tools] postinstall: ${script} could not run (${result.error.message}).`);
    failed = true;
  } else if ((result.status ?? 0) !== 0 || result.signal) {
    failed = true;
  }
}

// Manage the consuming repo's .gitignore for the artifacts audit-tools emits
// (always-ignore build/install assets + friction sidecar; visibility-conditional
// ignore of deliverables + meta-audit reflections). This is best-effort and must
// NEVER fail the install: the helper degrades on any error, and we wrap the whole
// step so a missing shared dist (fresh `npm ci`) or a detection hiccup is a warn,
// not a non-zero exit.
await manageArtifactGitignore();

process.exit(failed ? 1 : 0);

function ensureSourceCheckoutBuilt() {
  const sharedEntry = fileURLToPath(new URL("../dist/shared/index.js", import.meta.url));
  if (existsSync(sharedEntry)) return true;

  const sourceTree = fileURLToPath(new URL("../src", import.meta.url));
  const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  if (!existsSync(sourceTree) || !existsSync(tsconfig)) return true;

  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.warn(
      "[audit-tools] postinstall: source checkout needs a shared build, but npm_execpath is unavailable.",
    );
    return false;
  }

  console.log("[audit-tools] postinstall: building shared output for this source checkout...");
  const result = spawnSync(process.execPath, [npmCli, "run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || (result.status ?? 0) !== 0 || result.signal) {
    console.warn(
      `[audit-tools] postinstall: source-checkout build failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`}).`,
    );
    return false;
  }
  return existsSync(sharedEntry);
}

async function manageArtifactGitignore() {
  try {
    const shared = await import("audit-tools/shared");
    if (typeof shared.ensureArtifactGitignore !== "function") {
      return; // shared dist not built yet (fresh npm ci) — skip silently.
    }

    // The consuming repo root: npm sets INIT_CWD to the dir `npm install` ran in.
    const repoRoot = process.env.INIT_CWD || process.cwd();

    // Explicit operator override always wins. Single-sourced parse +
    // env-var name from shared (accepts private/public/track/ignore).
    const override =
      typeof shared.parseVisibilityOverride === "function"
        ? shared.parseVisibilityOverride(
            process.env[shared.REPO_VISIBILITY_ENV ?? "AUDIT_TOOLS_REPO_VISIBILITY"],
          )
        : resolveVisibilityOverride();

    const result = shared.ensureArtifactGitignore({
      repoRoot,
      override,
      runGh: runGhRepoVisibility,
    });
    if (result.changed) {
      console.log(
        `[audit-tools] postinstall: updated ${result.path} (repo visibility: ${result.visibility}).`,
      );
    }
  } catch (err) {
    console.warn(
      `[audit-tools] postinstall: .gitignore management skipped (${/** @type {any} */ (err)?.message ?? err}).`,
    );
  }
}

// Operator override via env: AUDIT_TOOLS_REPO_VISIBILITY=private|public (also
// accepts track=private / ignore=public). Anything else => no override.
function resolveVisibilityOverride() {
  const raw = (process.env.AUDIT_TOOLS_REPO_VISIBILITY || "").trim().toLowerCase();
  if (raw === "private" || raw === "track") return "private";
  if (raw === "public" || raw === "ignore") return "public";
  return null;
}

// Probe `gh repo view --json isPrivate`. Returns gh stdout, or null on any
// failure (gh missing, not a gh-known repo, non-zero exit). Never throws.
function runGhRepoVisibility(repoRoot) {
  try {
    const result = spawnSync("gh", ["repo", "view", "--json", "isPrivate"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    if (result.error || (result.status ?? 0) !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout : null;
  } catch {
    return null;
  }
}
