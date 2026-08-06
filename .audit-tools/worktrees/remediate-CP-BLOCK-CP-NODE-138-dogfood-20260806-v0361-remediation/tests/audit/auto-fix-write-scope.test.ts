import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

const { buildInScopePathsByExtension } = await import(
  "../../src/audit/orchestrator/autoFixExecutor.js"
);
const { resolveRuntimeValidationSpawnCommand } = await import(
  "../../src/audit/orchestrator/runtimeCommand.js"
);

// ---------------------------------------------------------------------------
// CP-NODE-10: auto-fix formatters target only eligible in-scope disposition
// files, never '.'/the whole repo (write-scope fix).
// ---------------------------------------------------------------------------

test("CP-NODE-10: buildInScopePathsByExtension groups only non-excluded files by extension", () => {
  const bundle: ArtifactBundle = {
    file_disposition: {
      files: [
        { path: "src/a.ts", status: "included" },
        { path: "src/b.ts", status: "included" },
        { path: "vendor/c.ts", status: "excluded" },
        { path: "scripts/d.py", status: "included" },
        { path: "README", status: "included" }, // no extension → skipped
      ],
    },
  };
  const byExt = buildInScopePathsByExtension(bundle);
  expect(byExt.get("ts")).toEqual(["src/a.ts", "src/b.ts"]);
  expect(byExt.get("py")).toEqual(["scripts/d.py"]);
  // The excluded file must NOT appear under any extension.
  expect(!(byExt.get("ts") ?? []).includes("vendor/c.ts"), "excluded files must never be passed to a formatter").toBeTruthy();
});

test("CP-NODE-10: no in-scope path is the whole-repo token '.'", () => {
  const bundle: ArtifactBundle = {
    file_disposition: {
      files: [{ path: "src/a.ts", status: "included" }],
    },
  };
  const byExt = buildInScopePathsByExtension(bundle);
  for (const paths of byExt.values()) {
    expect(!paths.includes("."), "formatter must never be invoked over '.' (whole repo)").toBeTruthy();
  }
});

// ---------------------------------------------------------------------------
// CP-NODE-10: win32 shim basename classification — an absolute/relative path to
// a package-manager shim must still be wrapped through cmd.exe.
// ---------------------------------------------------------------------------

test("CP-NODE-10: win32 wraps a package-manager shim given by absolute path", () => {
  const resolved = resolveRuntimeValidationSpawnCommand(
    ["C:\\tools\\npm.cmd", "test"],
    "win32",
    "cmd.exe",
  );
  // Before the fix, the directory prefix defeated the includes() check and the
  // shim ran unwrapped (npm.cmd is not directly spawnable on win32 → ENOENT).
  expect(resolved.command).toBe("cmd.exe");
  expect(resolved.args.includes("/c"), `expected cmd.exe /c wrapping, got: ${JSON.stringify(resolved.args)}`).toBeTruthy();
});

test("CP-NODE-10: win32 wraps a package-manager shim given by relative path", () => {
  const resolved = resolveRuntimeValidationSpawnCommand(
    ["./node_modules/.bin/npx.cmd", "vitest"],
    "win32",
    "cmd.exe",
  );
  expect(resolved.command).toBe("cmd.exe");
  expect(resolved.args.includes("/c")).toBeTruthy();
});

test("CP-NODE-10: win32 still wraps a bare package-manager name", () => {
  const resolved = resolveRuntimeValidationSpawnCommand(
    ["npm", "run", "build"],
    "win32",
    "cmd.exe",
  );
  expect(resolved.command).toBe("cmd.exe");
});

test("CP-NODE-10: win32 does not wrap a non-package-manager executable", () => {
  const resolved = resolveRuntimeValidationSpawnCommand(
    ["node", "-e", "1"],
    "win32",
    "cmd.exe",
  );
  expect(resolved.command).toBe("node");
});
