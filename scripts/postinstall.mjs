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
import { fileURLToPath } from "node:url";

let failed = false;
for (const script of ["./audit/postinstall.mjs", "./remediate/postinstall.mjs"]) {
  const scriptPath = fileURLToPath(new URL(script, import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit" });
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
      `[audit-tools] postinstall: .gitignore management skipped (${err?.message ?? err}).`,
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
    });
    if (result.error || (result.status ?? 0) !== 0) return null;
    return typeof result.stdout === "string" ? result.stdout : null;
  } catch {
    return null;
  }
}
