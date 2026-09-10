/**
 * Machine-global state-dir resolution (src/shared/io/stateDir.ts): the single
 * path source for machine-global audit/remediation state. Precedence contract:
 * explicit homeDir (per-call test injection) > AUDIT_CODE_STATE_DIR env override
 * (verbatim, no dir-name suffix) > os.homedir()/<defaultDirName>.
 */
import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

const { STATE_DIR_ENV_VAR, resolveStateDir, resolveAuditCodeStateDir } =
  await import("../../src/shared/io/stateDir.js");

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

/**
 * The vitest setup helper (tests/helpers/state-dir-setup.mjs) must pin EVERY
 * home-rooted path a suite's verdict could otherwise depend on — not only the
 * state dir. The analyzer caches are the second family: both are per-user
 * (`~/.audit-tools/analyzer-cache`, `~/.audit-tools/bincache`) and both hold
 * executable packages, so a box that happens to have one warm makes an analyzer
 * resolve that CI reports absent (and vice versa), and an e2e suite driving the
 * real acquisition path would DOWNLOAD a pinned release into the operator's home.
 *
 * Pinned here as a property of the shared helper rather than per-suite, because
 * per-suite discretion is exactly the failure mode: the suites that forgot were
 * green locally and machine-dependent everywhere else.
 */
describe("analyzer caches are pinned off the real user home by the shared setup helper", () => {
  it("pins the acquired-analyzer (binary) cache root", async () => {
    const { defaultCacheDir } = await import(
      "../../src/shared/analyzers/binaryAcquisition.js"
    );
    const pinned = process.env.AUDIT_TOOLS_BINARY_CACHE;
    expect(pinned, "the setup helper must set AUDIT_TOOLS_BINARY_CACHE").toBeTruthy();
    expect(
      defaultCacheDir().startsWith(join(homedir(), ".audit-tools")),
      "the resolved binary cache root must not be the real per-user root",
    ).toBe(false);
  });

  it("pins the analyzer-dependency cache root", async () => {
    const { analyzerCacheRoot } = await import("../../src/shared/tooling/analyzerDeps.js");
    expect(
      process.env.AUDIT_TOOLS_ANALYZER_CACHE,
      "the setup helper must set AUDIT_TOOLS_ANALYZER_CACHE",
    ).toBeTruthy();
    expect(
      analyzerCacheRoot().startsWith(join(homedir(), ".audit-tools")),
      "the resolved analyzer cache root must not be the real per-user root",
    ).toBe(false);
  });
});
