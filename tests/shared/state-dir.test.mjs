/**
 * Machine-global state-dir resolution (src/shared/io/stateDir.ts): the single
 * path source for `~/.audit-code` / `~/.remediate-code`. Precedence contract:
 * explicit homeDir (per-call test injection) > AUDIT_CODE_STATE_DIR env override
 * (verbatim, no dir-name suffix) > os.homedir()/<defaultDirName>.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const { STATE_DIR_ENV_VAR, resolveStateDir, resolveAuditCodeStateDir } =
  await import("../../src/shared/io/stateDir.ts");

describe("resolveStateDir", () => {
  it("defaults to homedir()/<defaultDirName> with no homeDir and no override", () => {
    expect(resolveStateDir(".audit-code", undefined, {})).toBe(
      join(homedir(), ".audit-code"),
    );
  });

  it("uses the env override VERBATIM (no dir-name suffix)", () => {
    const env = { [STATE_DIR_ENV_VAR]: "/tmp/fake-state" };
    expect(resolveStateDir(".audit-code", undefined, env)).toBe("/tmp/fake-state");
    // Both tools collapse into the same dir under the override — one var
    // redirects ALL machine-global state.
    expect(resolveStateDir(".remediate-code", undefined, env)).toBe("/tmp/fake-state");
  });

  it("explicit homeDir wins over the env override", () => {
    const env = { [STATE_DIR_ENV_VAR]: "/tmp/fake-state" };
    expect(resolveStateDir(".audit-code", "/home/test", env)).toBe(
      join("/home/test", ".audit-code"),
    );
  });

  it("ignores a blank/whitespace override", () => {
    expect(resolveStateDir(".audit-code", undefined, { [STATE_DIR_ENV_VAR]: "  " })).toBe(
      join(homedir(), ".audit-code"),
    );
  });

  it("resolveAuditCodeStateDir is the .audit-code draw of the same core", () => {
    expect(resolveAuditCodeStateDir("/home/test", {})).toBe(
      join("/home/test", ".audit-code"),
    );
    expect(resolveAuditCodeStateDir(undefined, { [STATE_DIR_ENV_VAR]: "/x" })).toBe("/x");
  });
});

describe("state-dir consumers honor the override", () => {
  it("resolveSourceDeclarationPath and resolveProxyCatalogPath route through it", async () => {
    const { resolveSourceDeclarationPath } = await import(
      "../../src/shared/providers/auditorSources.ts"
    );
    const { resolveProxyCatalogPath } = await import(
      "../../src/shared/providers/proxyCatalog.ts"
    );
    // The suite-level setup file (tests/helpers/state-dir-setup.mjs) always sets
    // the override, so the no-homeDir form must land inside it — never the box's
    // real ~/.audit-code.
    const override = process.env.AUDIT_CODE_STATE_DIR;
    expect(override).toBeTruthy();
    expect(resolveSourceDeclarationPath()).toBe(join(override, "sources-declared.json"));
    expect(resolveProxyCatalogPath()).toBe(join(override, "catalog-cache.json"));
  });
});
