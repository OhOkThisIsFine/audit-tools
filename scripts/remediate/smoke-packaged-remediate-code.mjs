#!/usr/bin/env node
import { spawnSync } from "child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const pkgRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packageVersion = JSON.parse(
  readFileSync(join(pkgRoot, "package.json"), "utf8"),
).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSpawn(command, args) {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

function spawnNpm(args, options) {
  const resolved = resolveSpawn(npm, args);
  return spawnSync(resolved.command, resolved.args, { windowsHide: true, ...options });
}

function defaultSmokeTmpRoot() {
  if (process.env.REMEDIATE_CODE_SMOKE_TMP_ROOT) {
    return process.env.REMEDIATE_CODE_SMOKE_TMP_ROOT;
  }
  return join(tmpdir(), ".remediate-code-smoke-tmp");
}

const smokeTmpRoot = defaultSmokeTmpRoot();
mkdirSync(smokeTmpRoot, { recursive: true });
const smokeRoot = mkdtempSync(join(smokeTmpRoot, "remediate-code-smoke-"));
const npmCacheDir = join(smokeRoot, "npm-cache");
const packDir = join(smokeRoot, "pack");
mkdirSync(npmCacheDir, { recursive: true });
mkdirSync(packDir, { recursive: true });

// Strip inherited npm_config_* overrides and publish credentials so that a
// nested `npm publish --dry-run` in the parent process does not suppress
// tarball creation or inject auth tokens into the child install.
function isolatedNpmEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      key.toLowerCase().startsWith("npm_config_") ||
      key.toLowerCase() === "node_auth_token" ||
      key.toLowerCase() === "npm_token"
    )
      continue;
    env[key] = value;
  }
  env.npm_config_dry_run = "false";
  env.NPM_CONFIG_DRY_RUN = "false";
  env.npm_config_cache = npmCacheDir;
  env.NPM_CONFIG_CACHE = npmCacheDir;
  return { ...env, ...extra };
}

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  PASS ${label}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${label}: ${err.message}`);
    failed++;
  }
}

const smokeStart = Date.now();
console.log("smoke:packaged-remediate-code");
console.log(
  "  isolating inherited npm_config_* overrides so dry-run does not suppress tarball creation",
);

// 1. Pack the single audit-tools package
console.log("  packing...");
const packStart = Date.now();
const packResult = spawnNpm(
  ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
  {
  cwd: pkgRoot,
  encoding: "utf8",
  env: isolatedNpmEnv(),
  },
);
if (packResult.status !== 0) {
  console.error(
    `npm pack failed after ${Date.now() - packStart}ms:`,
    packResult.stderr || packResult.error?.message,
  );
  rmSync(smokeRoot, { recursive: true, force: true });
  process.exit(1);
}

let packOutput;
try {
  packOutput = JSON.parse(packResult.stdout.trim());
} catch (err) {
  console.error(
    "npm pack --json output was not valid JSON (lifecycle script noise may have been mixed in):",
    packResult.stdout.slice(0, 500),
  );
  rmSync(smokeRoot, { recursive: true, force: true });
  process.exit(1);
}
if (!Array.isArray(packOutput) || packOutput.length === 0) {
  console.error("npm pack --json returned empty array — no tarball produced");
  rmSync(smokeRoot, { recursive: true, force: true });
  process.exit(1);
}
const tarball = join(packDir, packOutput[0].filename);
console.log(`  packed: ${tarball} (${Date.now() - packStart}ms)`);

// 2. Install into temp dir
const installDir = join(smokeRoot, "install");
mkdirSync(installDir, { recursive: true });
const fakeHome = join(installDir, "home");
const nodeModulesDir = join(installDir, "node_modules");

try {
  spawnNpm(["init", "-y"], {
    cwd: installDir,
    stdio: "ignore",
    env: isolatedNpmEnv(),
  });
  const installStart = Date.now();
  const installResult = spawnNpm(["install", "--no-package-lock", tarball], {
    cwd: installDir,
    encoding: "utf8",
    env: isolatedNpmEnv({ HOME: fakeHome, USERPROFILE: fakeHome }),
  });

  if (installResult.status !== 0) {
    console.error(`npm install failed after ${Date.now() - installStart}ms:`, installResult.stderr);
    failed++;
  } else {
    console.log(`  installed (${Date.now() - installStart}ms)`);
    const binPath = join(nodeModulesDir, ".bin", "remediate-code");

    check("bin/remediate-code exists after install", () => {
      const candidates = [binPath, binPath + ".cmd", binPath + ".ps1"];
      if (!candidates.some((p) => existsSync(p))) {
        throw new Error(`none of ${candidates.join(", ")} found`);
      }
    });

    // Use the .mjs wrapper directly for cross-platform reliability
    const wrapperPath = join(
      nodeModulesDir,
      "audit-tools",
      "remediate-code.mjs",
    );

    check("remediate-code --version exits 0", () => {
      const r = spawnSync(process.execPath, [wrapperPath, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (r.status !== 0) throw new Error(`exit ${r.status}`);
    });

    check(`remediate-code --version prints ${packageVersion}`, () => {
      const r = spawnSync(process.execPath, [wrapperPath, "--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (!r.stdout.includes(packageVersion))
        throw new Error(`got: ${r.stdout.trim()}`);
    });

    check("postinstall installed ~/.claude/commands/remediate-code.md", () => {
      const target = join(fakeHome, ".claude", "commands", "remediate-code.md");
      if (!existsSync(target)) throw new Error(`not found at ${target}`);
    });

    check("installed command content matches source body (no frontmatter)", () => {
      const target = join(fakeHome, ".claude", "commands", "remediate-code.md");
      const installed = readFileSync(target, "utf8");
      const rawSource = readFileSync(
        join(pkgRoot, "skills", "remediate-code", "remediate-code.prompt.md"),
        "utf8",
      );
      const normalized = rawSource.replace(/\r\n/g, "\n");
      const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n?/u);
      const sourceBody = fmMatch ? normalized.slice(fmMatch[0].length) : normalized;
      if (installed !== sourceBody) throw new Error("content mismatch (installed command should have frontmatter stripped)");
    });
  }
} finally {
  rmSync(tarball, { force: true });
  rmSync(smokeRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed (${Date.now() - smokeStart}ms total)`);
if (failed > 0) process.exit(1);
