import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Resolve the hook path relative to the repo root (three levels up from
// tests/). The canonical hook is the tracked `.claude/hooks/session-start.sh`
// (kept via the `!.claude/hooks/session-start.sh` negation in .gitignore); the
// `.codex/` mirror is host-local and gitignored, so it is absent in CI.
const HOOK_PATH = new URL(
  "../../../.claude/hooks/session-start.sh",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1"); // strip leading slash on Windows paths

// On Windows a bare `bash` on PATH is frequently the WSL launcher
// (System32\bash.exe), which can't run a script passed as a Windows path and
// exits non-zero when no distro is installed. Derive a POSIX-compatible bash
// from the `git` install (Git Bash) first, and only fall back to PATH `bash`
// (the real bash on POSIX systems) when its probe succeeds. Null → skip.
function findPosixBash() {
  const candidates = [];
  if (process.env.AUDIT_CODE_BASH) candidates.push(process.env.AUDIT_CODE_BASH);
  try {
    const locator = process.platform === "win32" ? "where" : "which";
    const gitExe = execFileSync(locator, ["git"], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim();
    if (gitExe) {
      const gitRoot = dirname(dirname(gitExe)); // <git>/cmd/git(.exe) -> <git>
      candidates.push(join(gitRoot, "bin", "bash.exe"));
      candidates.push(join(gitRoot, "usr", "bin", "bash.exe"));
      candidates.push(join(gitRoot, "bin", "bash"));
    }
  } catch {
    // git not found — fall through to PATH bash
  }
  candidates.push("bash");
  for (const cand of candidates) {
    try {
      const probe = spawnSync(cand, ["-c", "exit 0"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (!probe.error && probe.status === 0) return cand;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const BASH = findPosixBash();
const SKIP = BASH
  ? false
  : "no POSIX-compatible bash available (e.g. only the WSL launcher is on PATH)";

function spawnHook(env) {
  return spawnSync(BASH, [HOOK_PATH], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

await test("session-start.sh is a no-op when CLAUDE_CODE_REMOTE is not set", { skip: SKIP }, () => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_REMOTE;

  const result = spawnSync(BASH, [HOOK_PATH], {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 0, `script exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout, "", "expected no stdout");
  assert.equal(result.stderr, "", "expected no stderr");
});

await test("session-start.sh is a no-op when CLAUDE_CODE_REMOTE is set to a value other than 'true'", { skip: SKIP }, () => {
  const result = spawnHook({ CLAUDE_CODE_REMOTE: "false" });

  assert.equal(result.status, 0, `script exited ${result.status}: ${result.stderr}`);
  assert.equal(result.stdout, "", "expected no stdout");
  assert.equal(result.stderr, "", "expected no stderr");
});

await test("session-start.sh runs npm install and both build commands in order when CLAUDE_CODE_REMOTE=true", { skip: SKIP }, (t) => {
  // Create a temp dir acting as CLAUDE_PROJECT_DIR.
  const projectDir = mkdtempSync(join(tmpdir(), "session-hook-proj-"));
  // Create a stub npm script that records each invocation's args to a log file.
  const stubDir = mkdtempSync(join(tmpdir(), "session-hook-stubs-"));
  const logFile = join(stubDir, "npm.log");

  const stubNpm = join(stubDir, "npm");
  writeFileSync(
    stubNpm,
    `#!/bin/bash\necho "$@" >> "${logFile.replace(/\\/g, "/")}"\nexit 0\n`,
    { mode: 0o755 },
  );

  // Prepend stub dir so our fake npm shadows the real one.
  const result = spawnSync(BASH, [HOOK_PATH], {
    env: {
      ...process.env,
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_PROJECT_DIR: projectDir,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(
    result.status,
    0,
    `script exited ${result.status}: ${result.stderr}`,
  );

  let log = "";
  try {
    log = readFileSync(logFile, "utf8");
  } catch {
    assert.fail("npm stub log file was not created — no npm calls were made");
  }

  const lines = log.trim().split("\n");
  assert.equal(lines.length, 3, `expected 3 npm invocations, got: ${JSON.stringify(lines)}`);
  assert.equal(lines[0], "install");
  assert.equal(lines[1], "run build -w @audit-tools/shared");
  assert.equal(lines[2], "run build");
});

await test("session-start.sh propagates non-zero exit when npm install fails", { skip: SKIP }, () => {
  const projectDir = mkdtempSync(join(tmpdir(), "session-hook-fail-proj-"));
  const stubDir = mkdtempSync(join(tmpdir(), "session-hook-fail-stubs-"));

  const stubNpm = join(stubDir, "npm");
  writeFileSync(
    stubNpm,
    `#!/bin/bash\nexit 1\n`,
    { mode: 0o755 },
  );

  const result = spawnSync(BASH, [HOOK_PATH], {
    env: {
      ...process.env,
      CLAUDE_CODE_REMOTE: "true",
      CLAUDE_PROJECT_DIR: projectDir,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.notEqual(
    result.status,
    0,
    "expected non-zero exit when npm install fails (set -euo pipefail)",
  );
});
