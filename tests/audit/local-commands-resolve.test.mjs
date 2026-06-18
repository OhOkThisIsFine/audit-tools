import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { __resolveFromPathForTests } = await import("../../src/audit/orchestrator/localCommands.ts");

// Helpers ─────────────────────────────────────────────────────────────────────

function makeTmpDir(label) {
  const dir = join(tmpdir(), `audit-code-test-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// Tests ───────────────────────────────────────────────────────────────────────

test("resolveFromPath returns null for command not found in PATH", () => {
  const dir = makeTmpDir("notfound");
  try {
    const result = withEnv({ PATH: dir, PATHEXT: ".EXE;.CMD" }, () =>
      __resolveFromPathForTests("definitely-not-a-real-command-xyz")
    );
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFromPath finds bare command name in PATH dir on current platform", () => {
  const dir = makeTmpDir("bare");
  const cmdName = process.platform === "win32" ? "mycommand.exe" : "mycommand";
  const cmdPath = join(dir, cmdName);
  writeFileSync(cmdPath, "");
  try {
    const lookupName = process.platform === "win32" ? "mycommand" : "mycommand";
    const pathext = process.platform === "win32" ? ".EXE;.CMD" : undefined;
    const result = withEnv({ PATH: dir, ...(pathext ? { PATHEXT: pathext } : {}) }, () =>
      __resolveFromPathForTests(lookupName)
    );
    assert.equal(result, cmdPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFromPath returns null when PATH is empty", () => {
  const result = withEnv({ PATH: "" }, () =>
    __resolveFromPathForTests("node")
  );
  assert.equal(result, null);
});

test("resolveFromPath returns null for empty command string", () => {
  const result = __resolveFromPathForTests("");
  assert.equal(result, null);
});

test("resolveFromPath returns null for whitespace-only command string", () => {
  const result = __resolveFromPathForTests("   ");
  assert.equal(result, null);
});

test("resolveFromPath resolves an absolute path that exists", () => {
  const dir = makeTmpDir("abs");
  const cmdPath = join(dir, "myabstool");
  writeFileSync(cmdPath, "");
  try {
    const result = __resolveFromPathForTests(cmdPath);
    assert.equal(result, cmdPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFromPath returns null for an absolute path that does not exist", () => {
  const result = __resolveFromPathForTests("/definitely/not/real/path/xyz");
  assert.equal(result, null);
});

// Win32-specific: extension probing order ─────────────────────────────────────

if (process.platform === "win32") {
  test("resolveFromPath on win32: .cmd extension is found before bare name", () => {
    const dir = makeTmpDir("win32-ext");
    const cmdPath = join(dir, "mycommand.cmd");
    const barePath = join(dir, "mycommand");
    writeFileSync(cmdPath, "");
    writeFileSync(barePath, "");
    try {
      const result = withEnv({ PATH: dir, PATHEXT: ".CMD;.EXE" }, () =>
        __resolveFromPathForTests("mycommand")
      );
      // Extensions are probed before the bare name (empty-string suffix is last)
      assert.equal(result, cmdPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveFromPath on win32: command with extension uses direct path only", () => {
    const dir = makeTmpDir("win32-hasext");
    const cmdPath = join(dir, "mycommand.exe");
    writeFileSync(cmdPath, "");
    try {
      const result = withEnv({ PATH: dir, PATHEXT: ".EXE;.CMD" }, () =>
        __resolveFromPathForTests("mycommand.exe")
      );
      assert.equal(result, cmdPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolveFromPath on win32: bare name found when no extension variant exists", () => {
    const dir = makeTmpDir("win32-bare");
    const barePath = join(dir, "mycommand");
    writeFileSync(barePath, "");
    try {
      const result = withEnv({ PATH: dir, PATHEXT: ".EXE;.CMD" }, () =>
        __resolveFromPathForTests("mycommand")
      );
      assert.equal(result, barePath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
