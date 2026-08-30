import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";

// Heavy spawn suite: real subprocess round-trips, and the cases are
// `concurrent`, so under a full-suite run they contend with siblings.
// Single-sourced ceiling — see tests/helpers/heavy-timeout.mjs for the rationale.
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
vi.setConfig({ testTimeout: HEAVY_AUDIT_TEST_TIMEOUT_MS });
import {
  mkdtemp,
  rm,
  mkdir,
  stat,
  writeFile,
  readFile,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldBuildDistForPaths,
  assertWorkspaceInstalled,
  hasLeadingFlag,
  setFlag,
} from "../../wrapper/audit-code-wrapper-lib.mjs";
import {
  shouldBuildDistForPaths as shouldBuildDistForPathsDirect,
  assertWorkspaceInstalled as assertWorkspaceInstalledDirect,
} from "../../wrapper/audit-code-wrapper-build.mjs";
import {
  INSTALL_HOST_DEFINITIONS,
  INSTALL_HOST_ORDER,
  getInstallHostKeys,
  getInstallProfile,
  _INSTALL_HOST_ORDER,
  _INSTALL_HOST_DEFINITIONS,
  _getInstallHostKeys,
  _getInstallProfile,
} from "../../wrapper/audit-code-wrapper-install-hosts.mjs";
import {
  assertOpenCodeAuditPermissionConfig,
  buildMergedOpenCodeProjectConfig,
  OPENCODE_AUDIT_BASH_PERMISSION,
  renderOpenCodePermissionConfig,
} from "../../wrapper/audit-code-wrapper-opencode.mjs";
import {
  packageVersion,
  repoRoot,
  runWrapper,
  spawnWrapper,
} from "./helpers/wrapper-harness.js";

const here = join(repoRoot, "tests", "audit");

test.concurrent("wrapper build freshness ignores package metadata churn when dist is newer than source inputs", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-build-freshness-"));
  try {
    const sourceDir = join(tempDir, "src");
    const distDir = join(tempDir, "dist");
    const tsconfigFile = join(tempDir, "tsconfig.json");
    const sourceFile = join(sourceDir, "index.ts");
    const distFile = join(distDir, "index.js");
    const packageJsonFile = join(tempDir, "package.json");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(sourceFile, "export const value = 1;\n");
    await writeFile(tsconfigFile, "{\n  \"compilerOptions\": {\"outDir\": \"dist\"}\n}\n");
    await writeFile(distFile, "export const value = 1;\n");
    await writeFile(packageJsonFile, "{\n  \"name\": \"fixture\"\n}\n");

    const sourceTime = new Date("2026-04-23T14:00:00.000Z");
    const distTime = new Date("2026-04-23T14:05:00.000Z");
    const packageTime = new Date("2026-04-23T14:10:00.000Z");
    await utimes(sourceDir, sourceTime, sourceTime);
    await utimes(sourceFile, sourceTime, sourceTime);
    await utimes(tsconfigFile, sourceTime, sourceTime);
    await utimes(distDir, distTime, distTime);
    await utimes(distFile, distTime, distTime);
    await utimes(packageJsonFile, packageTime, packageTime);

    const shouldBuild = await shouldBuildDistForPaths({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });

    expect(shouldBuild).toBe(false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("assertWorkspaceInstalled flags missing or foreign audit-tools/shared", () => {
  const checkoutRoot = join(here, "fixture-checkout");

  // Not resolvable at all → dependencies were never installed.
  assert.throws(
    () => assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath: null }),
    /Dependencies are not installed/,
  );

  // Resolves into a *different* checkout — the fresh-git-worktree trap.
  assert.throws(
    () =>
      assertWorkspaceInstalled({
        checkoutRoot,
        sharedManifestPath: join(
          here,
          "other-checkout",
          "node_modules",
          "@audit-tools",
          "shared",
          "package.json",
        ),
      }),
    /outside this checkout/,
  );

  // Resolves inside this checkout → installed correctly, no throw.
  assert.doesNotThrow(() =>
    assertWorkspaceInstalled({
      checkoutRoot,
      sharedManifestPath: join(
        checkoutRoot,
        "node_modules",
        "@audit-tools",
        "shared",
        "package.json",
      ),
    }),
  );
});

test.concurrent("audit-code wrapper prints help text", async () => {
  const { stdout } = await runWrapper(["--help"]);
  expect(stdout.includes("Usage: node audit-code.mjs <command>")).toBeTruthy();
  expect(stdout.includes("Primary usage (conversation-first):")).toBeTruthy();
  expect(stdout.includes("next-step advances deterministic audit state")).toBeTruthy();
  expect(stdout.includes("advance-audit")).toBe(false);
  expect(stdout.includes("explain-task <task_id>")).toBeTruthy();
  // The four installer-verb lines are RENDERED from wrapper/installer-verb-help.mjs
  // and pinned against that declaration by tests/shared/installer-verb-help.test.ts;
  // restating them here is the drift this listing already suffered.
  // The batch loop and its flags are gone from the product surface.
  expect(!stdout.includes("--single-step")).toBeTruthy();
  expect(!stdout.includes("run-to-completion")).toBeTruthy();
});

test.concurrent("audit-code wrapper bare invocation prints help and exits 0 without starting an audit", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-bare-help-"));
  try {
    const { stdout } = await runWrapper([], { cwd: tempDir });
    expect(stdout.includes("Usage: node audit-code.mjs <command>")).toBeTruthy();
    expect(stdout.includes("next-step advances deterministic audit state")).toBeTruthy();
    // The help path must not create audit state.
    await assert.rejects(() => stat(join(tempDir, ".audit-tools")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent.each(["--help", "-h"])(
  "audit-code wrapper subcommand %s skips artifact directory creation",
  async (helpFlag) => {
    const tempDir = await mkdtemp(join(tmpdir(), "audit-code-subcommand-help-"));
    const artifactsDir = join(tempDir, "artifacts");
    try {
      const { stdout } = await runWrapper(
        ["next-step", helpFlag, "--root", tempDir, "--artifacts-dir", artifactsDir],
        { cwd: tempDir },
      );
      expect(stdout).toContain("Usage: audit-code next-step [options]");
      await assert.rejects(() => stat(artifactsDir));
      await assert.rejects(() => stat(join(tempDir, ".audit-tools")));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test.concurrent("audit-code wrapper rejects unknown commands with exit 1 and authoritative guidance", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-unknown-cmd-"));
  try {
    const { child, stderrRef } = spawnWrapper(["definitely-not-a-command"], {
      cwd: tempDir,
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(code).toBe(1);
    // The wrapper forwards every non-special command to the dist CLI, so an
    // unknown command surfaces dist's authoritative error + available-commands
    // list (the single source of truth), not a wrapper-local message that can
    // drift from the real command set.
    expect(stderrRef.value).toMatch(/Unknown command: definitely-not-a-command/);
    expect(stderrRef.value).toMatch(/Available commands:/);
    // The failure path must not create audit state.
    await assert.rejects(() => stat(join(tempDir, ".audit-tools")));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper forwards any dist command through the passthrough (no per-command branch)", async () => {
  // Drift guard: a command that has NO explicit wrapper branch (here `status`,
  // which was cli.ts-only and historically unreachable through the packaged bin
  // — the same class of gap as the `cleanup` regression) must still reach the
  // dist CLI via the passthrough default, never fall through to an
  // unknown-command failure. This is what makes wrapper/CLI parity structural
  // rather than a hand-maintained dispatch table.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-passthrough-"));
  try {
    const { child, stderrRef } = spawnWrapper(["status"], { cwd: tempDir });
    await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect(stderrRef.value).not.toMatch(/Unknown command: status/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper routes `cleanup` to the dist command (not an unknown-command failure)", async () => {
  // Regression: `cleanup` had a full case in src/audit/cli.ts but was never wired
  // into the wrapper dispatch table, so the documented `audit-code cleanup` was
  // unreachable through the packaged bin (fell through to "Unknown command").
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-cleanup-"));
  try {
    const { child, stdoutRef, stderrRef } = spawnWrapper(["cleanup", "--dry-run"], {
      cwd: tempDir,
    });
    await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    // The dispatch table recognizes it: no "Unknown command: cleanup".
    expect(stderrRef.value).not.toMatch(/Unknown command: cleanup/);
    // It reaches the real cleanup executor, which emits its structured result.
    expect(stdoutRef.value).toMatch(/"artifacts_dir"/);
    expect(stdoutRef.value).toMatch(/"dry_run":\s*true/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test.concurrent("audit-code wrapper prints package version", async () => {
  const { stdout } = await runWrapper(["--version"]);
  expect(stdout.trim()).toBe(packageVersion);
});

test.concurrent("audit-code wrapper prints the canonical prompt asset path", async () => {
  const { stdout } = await runWrapper(["prompt-path"]);
  const promptPath = stdout.trim();

  expect(promptPath.length > 0).toBeTruthy();
  expect(promptPath.replaceAll("\\", "/")).toMatch(/skills\/audit-code\/audit-code\.prompt\.md$/);

  const info = await stat(promptPath);
  expect(info.isFile()).toBe(true);
});

test.concurrent("slash prompt is a tiny next-step loader without dispatch branches", async () => {
  const prompt = await readFile(
    join(repoRoot, "skills", "audit-code", "audit-code.prompt.md"),
    "utf8",
  );

  expect(prompt).toMatch(/audit-code ensure --quiet/);
  expect(prompt).toMatch(/audit-code next-step/);
  expect(prompt).toMatch(/follow only.*prompt_path/is);
  expect(prompt).not.toMatch(/prepare-dispatch/);
  expect(prompt).not.toMatch(/single-task fallback/i);
  expect(prompt).not.toMatch(/Step 2/i);
});

test.concurrent("build helpers are isolated from install helpers", async () => {
  // shouldBuildDistForPaths and assertWorkspaceInstalled are importable directly
  // from audit-code-wrapper-build.mjs and produce the same results as the
  // re-exports from audit-code-wrapper-lib.mjs.
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-build-isolation-"));
  try {
    const sourceDir = join(tempDir, "src");
    const distDir = join(tempDir, "dist");
    const tsconfigFile = join(tempDir, "tsconfig.json");
    const sourceFile = join(sourceDir, "index.ts");
    const distFile = join(distDir, "index.js");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(sourceFile, "export const value = 1;\n");
    await writeFile(tsconfigFile, '{"compilerOptions":{"outDir":"dist"}}\n');
    await writeFile(distFile, "export const value = 1;\n");

    const sourceTime = new Date("2026-04-23T14:00:00.000Z");
    const distTime = new Date("2026-04-23T14:05:00.000Z");
    await utimes(sourceDir, sourceTime, sourceTime);
    await utimes(sourceFile, sourceTime, sourceTime);
    await utimes(tsconfigFile, sourceTime, sourceTime);
    await utimes(distDir, distTime, distTime);
    await utimes(distFile, distTime, distTime);

    // Direct import from build module matches re-export from lib.
    const resultDirect = await shouldBuildDistForPathsDirect({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });
    const resultViaLib = await shouldBuildDistForPaths({
      distEntryPath: distFile,
      sourceRootPath: sourceDir,
      tsconfigPath: tsconfigFile,
    });
    expect(resultDirect).toBe(false);
    expect(resultDirect).toBe(resultViaLib);

    // assertWorkspaceInstalled direct import behaves identically to the lib re-export.
    const checkoutRoot = join(tempDir, "checkout");
    assert.throws(
      () => assertWorkspaceInstalledDirect({ checkoutRoot, sharedManifestPath: null }),
      /Dependencies are not installed/,
    );
    assert.throws(
      () => assertWorkspaceInstalled({ checkoutRoot, sharedManifestPath: null }),
      /Dependencies are not installed/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // INSTALL_HOST_DEFINITIONS, INSTALL_HOST_ORDER, getInstallHostKeys,
  // getInstallProfile are importable directly from install-hosts and match the
  // underscore-aliased re-exports from wrapper-lib.
  expect(INSTALL_HOST_ORDER).toEqual(_INSTALL_HOST_ORDER);
  expect(INSTALL_HOST_DEFINITIONS).toEqual(_INSTALL_HOST_DEFINITIONS);
  expect(getInstallHostKeys("all")).toEqual(_getInstallHostKeys("all"));
  expect(getInstallProfile("opencode")).toEqual(_getInstallProfile("opencode"));
});

test.concurrent("hasLeadingFlag recognizes an informational flag only before the first command token (CE-007)", () => {
  // A bare informational flag is a leading flag.
  expect(hasLeadingFlag(["--version"], "--version")).toBe(true);
  expect(hasLeadingFlag(["-v"], "-v")).toBe(true);
  expect(hasLeadingFlag(["--help"], "--help")).toBe(true);
  // A leading flag is still recognized after OTHER leading flags.
  expect(hasLeadingFlag(["--verbose", "--version"], "--version")).toBe(true);
  // A flag AFTER the first non-flag token (the command) is NOT hijacked — it
  // belongs to the dist CLI. This is the CE-007 regression: `explain-task -v`
  // must forward `-v`, not print the wrapper version.
  expect(hasLeadingFlag(["explain-task", "-v"], "-v")).toBe(false);
  expect(hasLeadingFlag(["explain-task", "--version"], "--version")).toBe(false);
  expect(hasLeadingFlag(["next-step", "--help"], "--help")).toBe(false);
  // Absent flag.
  expect(hasLeadingFlag(["next-step"], "--version")).toBe(false);
});

test.concurrent("setFlag overwrites an existing flag value and appends when absent (CE-001)", () => {
  // Overwrite: a user-supplied relative --root is replaced with the resolved
  // absolute value the wrapper computed, instead of being forwarded raw.
  const withFlag = ["--root", "."];
  setFlag(withFlag, "--root", "/abs/root");
  expect(withFlag).toEqual(["--root", "/abs/root"]);
  // Append: a missing flag is added.
  const withoutFlag = ["next-step"];
  setFlag(withoutFlag, "--artifacts-dir", "/abs/art");
  expect(withoutFlag).toEqual(["next-step", "--artifacts-dir", "/abs/art"]);
});

test.concurrent("audit-code wrapper does not hijack a post-command informational flag (CE-007)", async () => {
  // `explain-task -v` forwards `-v` to the dist CLI rather than printing the
  // wrapper version. Without a task the dist command exits non-zero, so
  // runWrapper rejects — the key assertion is that stdout is NOT just the
  // wrapper's version string (which would prove the wrapper hijacked `-v`).
  await runWrapper(["explain-task", "-v"]).then(
    ({ stdout }) => {
      expect(stdout.trim()).not.toBe(packageVersion);
    },
    (error) => {
      expect(String(error.message).trim()).not.toBe(packageVersion);
    },
  );
});

test.concurrent("OpenCode permission helpers are importable from the dedicated module", () => {
  // assertOpenCodeAuditPermissionConfig throws when required bash rules are missing.
  const badPermission = {
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: { ".audit-code/**": "allow", ".audit-tools/**": "allow" },
    bash: {
      // Missing required allow/deny rules entirely
      "*": "ask",
    },
  };
  assert.throws(
    () => assertOpenCodeAuditPermissionConfig(badPermission, "permission"),
    /bash must allow|bash must deny/,
  );

  // assertOpenCodeAuditPermissionConfig pins the hardened shape (V3): a broad
  // bash wildcard or an external_directory allow-all must throw.
  const fullBash = { ...OPENCODE_AUDIT_BASH_PERMISSION };
  assert.throws(
    () =>
      assertOpenCodeAuditPermissionConfig(
        { read: "allow", glob: "allow", grep: "allow", edit: { ".audit-code/**": "allow", ".audit-tools/**": "allow" }, bash: { ...fullBash, "*": "allow" } },
        "permission",
      ),
    /bash must set "\*" to "ask"/,
  );
  assert.throws(
    () =>
      assertOpenCodeAuditPermissionConfig(
        { read: "allow", glob: "allow", grep: "allow", external_directory: { "*": "allow" }, edit: { ".audit-code/**": "allow", ".audit-tools/**": "allow" }, bash: fullBash },
        "permission",
      ),
    /external_directory must not allow-all/,
  );

  // buildMergedOpenCodeProjectConfig with an empty existing config preserves
  // the generated values, seeds the hardened bash wildcard, and seeds no
  // external_directory rule at all.
  const builtFromEmpty = buildMergedOpenCodeProjectConfig({}, "/tmp/repo");
  expect(builtFromEmpty.permission?.read).toBe("allow");
  expect(builtFromEmpty.permission?.glob).toBe("allow");
  expect(builtFromEmpty.permission?.grep).toBe("allow");
  expect(builtFromEmpty.permission?.bash?.["*"]).toBe("ask");
  expect(builtFromEmpty.permission?.external_directory).toBeUndefined();
  expect(builtFromEmpty.agent?.auditor?.permission?.read).toBe("allow");
  expect(builtFromEmpty.agent?.auditor?.permission?.bash?.["*"]).toBe("ask");
  expect(builtFromEmpty.agent?.auditor?.permission?.external_directory).toBeUndefined();
  // The freshly built config satisfies the hardened assert at both scopes.
  assertOpenCodeAuditPermissionConfig(builtFromEmpty.permission, "permission");
  assertOpenCodeAuditPermissionConfig(builtFromEmpty.agent?.auditor?.permission, "agent.auditor.permission");
});

test.concurrent("OPENCODE_AUDIT_BASH_PERMISSION includes Select-String", () => {
  expect(OPENCODE_AUDIT_BASH_PERMISSION["Select-String *"], "OPENCODE_AUDIT_BASH_PERMISSION must include 'Select-String *': 'allow' as the source of truth").toBe("allow");
});

test.concurrent("renderOpenCodePermissionConfig bash block includes Select-String", () => {
  const config = renderOpenCodePermissionConfig();
  expect(config.bash["Select-String *"], "renderOpenCodePermissionConfig() must return a bash block containing 'Select-String *': 'allow'").toBe("allow");
});

test.concurrent("buildMergedOpenCodeProjectConfig migrates the managed external_directory allow-all and preserves other user values (V3)", () => {
  // A pre-hardening tool-managed '*': 'allow' is migrated away entirely.
  const managedExisting = { permission: { external_directory: { "*": "allow" } } };
  const mergedManaged = buildMergedOpenCodeProjectConfig(managedExisting, "/tmp/repo");
  expect(mergedManaged.permission.external_directory, "the historically managed external_directory allow-all must be migrated away").toBeUndefined();

  // A managed allow-all wildcard alongside user-authored specific keys: only
  // the wildcard is dropped, the user keys survive.
  const mixedExisting = { permission: { external_directory: { "*": "allow", "C:/somewhere/**": "ask" } } };
  const mergedMixed = buildMergedOpenCodeProjectConfig(mixedExisting, "/tmp/repo");
  expect(mergedMixed.permission.external_directory, "user-authored external_directory keys must survive the allow-all migration").toEqual({ "C:/somewhere/**": "ask" });

  // Non-matching user wildcards survive untouched ('ask' / 'deny').
  const askExisting = { permission: { external_directory: { "*": "ask" } } };
  const mergedAsk = buildMergedOpenCodeProjectConfig(askExisting, "/tmp/repo");
  expect(mergedAsk.permission.external_directory["*"], "user '*': 'ask' on external_directory must survive untouched").toBe("ask");
  const denyExisting = { permission: { external_directory: { "*": "deny" } } };
  const mergedDeny = buildMergedOpenCodeProjectConfig(denyExisting, "/tmp/repo");
  expect(mergedDeny.permission.external_directory["*"], "user '*': 'deny' on external_directory must survive untouched").toBe("deny");

  // Undefined existing external_directory stays absent — the hardened render
  // never seeds the key.
  const undefinedExisting = { permission: {} };
  const mergedUndefined = buildMergedOpenCodeProjectConfig(undefinedExisting, "/tmp/repo");
  expect(mergedUndefined.permission.external_directory, "no external_directory rule may be seeded on a fresh config").toBeUndefined();

  // A user-owned external_directory object with no '*' key is preserved as-is;
  // no wildcard is added.
  const noStarExisting = { permission: { external_directory: { "some/path/**": "ask" } } };
  const mergedNoStar = buildMergedOpenCodeProjectConfig(noStarExisting, "/tmp/repo");
  expect(mergedNoStar.permission.external_directory, "a user external_directory without '*' must be preserved without adding a wildcard").toEqual({ "some/path/**": "ask" });
});

test.concurrent("buildMergedOpenCodeProjectConfig migrates a pre-hardening bash allow wildcard to 'ask' and preserves other user wildcards (V3)", () => {
  // A pre-hardening agent-scope bash '*': 'allow' (the historically managed
  // broad value) migrates to the generated 'ask' so regeneration converges to
  // the hardened shape the assert requires.
  const broadAgentExisting = {
    agent: { auditor: { permission: { bash: { "*": "allow" } } } },
  };
  const mergedBroad = buildMergedOpenCodeProjectConfig(broadAgentExisting, "/tmp/repo");
  expect(mergedBroad.agent.auditor.permission.bash["*"], "the historically managed agent bash '*': 'allow' must migrate to 'ask'").toBe("ask");
  expect(mergedBroad.permission.bash["*"], "the top-level bash ceiling must be 'ask' after migration").toBe("ask");

  // A user-authored 'deny' wildcard at agent scope survives untouched (only
  // the exactly-matching managed 'allow' is migrated).
  const denyAgentExisting = {
    agent: { auditor: { permission: { bash: { "*": "deny" } } } },
  };
  const mergedDenyAgent = buildMergedOpenCodeProjectConfig(denyAgentExisting, "/tmp/repo");
  expect(mergedDenyAgent.agent.auditor.permission.bash["*"], "a user agent bash '*': 'deny' must survive untouched").toBe("deny");

  // Parity with edit: a user '*': 'deny' on edit is preserved for '*' key
  // (managed rules use withoutOpenCodeWildcard for edit).
  const editDenyExisting = { permission: { edit: { "*": "deny" } } };
  const mergedEditDeny = buildMergedOpenCodeProjectConfig(editDenyExisting, "/tmp/repo");
  expect(mergedEditDeny.permission.edit["*"], "user '*': 'deny' on edit is preserved (agent-scope merge keeps existing wildcard)").toBe("deny");
});
