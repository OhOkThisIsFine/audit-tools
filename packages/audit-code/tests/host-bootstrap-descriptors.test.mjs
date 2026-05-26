import test from "node:test";
import assert from "node:assert/strict";
import {
  _INSTALL_HOST_ORDER as INSTALL_HOST_ORDER,
  _INSTALL_HOST_DEFINITIONS as INSTALL_HOST_DEFINITIONS,
  _getInstallHostKeys as getInstallHostKeys,
  _getInstallProfile as getInstallProfile,
} from "../audit-code-wrapper-lib.mjs";

test("every host in INSTALL_HOST_ORDER has a complete descriptor with verify", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const def = INSTALL_HOST_DEFINITIONS[hostKey];
    assert.ok(def, `Descriptor must exist for host "${hostKey}"`);
    assert.equal(def.host, hostKey, `Descriptor.host must match key "${hostKey}"`);
    assert.ok(typeof def.label === "string" && def.label.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty label`);
    assert.ok(typeof def.support_level === "string",
      `Descriptor for "${hostKey}" must have a support_level`);
    assert.ok(typeof def.setup_kind === "string",
      `Descriptor for "${hostKey}" must have a setup_kind`);
    assert.ok(typeof def.summary === "string" && def.summary.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty summary`);
    assert.ok(typeof def.primary_path_key === "string",
      `Descriptor for "${hostKey}" must have a primary_path_key`);
    assert.ok(Array.isArray(def.supporting_path_keys),
      `Descriptor for "${hostKey}" must have supporting_path_keys array`);
    assert.ok(Array.isArray(def.steps) && def.steps.length > 0,
      `Descriptor for "${hostKey}" must have a non-empty steps array`);
    assert.ok(def.profile && typeof def.profile === "object",
      `Descriptor for "${hostKey}" must have a profile object`);
    assert.ok(typeof def.verify === "function",
      `Descriptor for "${hostKey}" must have a verify function`);
  }
});

test("descriptor table covers exactly codex, claude-desktop, opencode, vscode, and antigravity", () => {
  const definedHosts = Object.keys(INSTALL_HOST_DEFINITIONS).sort();
  const expectedHosts = [
    "antigravity",
    "claude-desktop",
    "codex",
    "opencode",
    "vscode",
  ];
  assert.deepEqual(definedHosts, expectedHosts);
});

test("getInstallHostKeys returns single key for known hosts", () => {
  for (const hostKey of INSTALL_HOST_ORDER) {
    const keys = getInstallHostKeys(hostKey);
    assert.deepEqual(keys, [hostKey]);
  }
});

test("getInstallHostKeys returns all hosts for 'all'", () => {
  const keys = getInstallHostKeys("all");
  assert.deepEqual(keys, INSTALL_HOST_ORDER);
});

test("getInstallHostKeys throws for unknown host", () => {
  assert.throws(() => getInstallHostKeys("nonexistent-host"), {
    message: /Unsupported host "nonexistent-host"/,
  });
});

test("getInstallProfile derives correct flags from host descriptors", () => {
  // codex should set writeAgents
  const codexProfile = getInstallProfile("codex");
  assert.equal(codexProfile.writeAgents, true);
  assert.equal(codexProfile.writeVSCode, false);

  // vscode should set writeVSCode and writeCopilotInstructions
  const vscodeProfile = getInstallProfile("vscode");
  assert.equal(vscodeProfile.writeVSCode, true);
  assert.equal(vscodeProfile.writeCopilotInstructions, true);
  assert.equal(vscodeProfile.writeAgents, false);

  // 'all' should merge all profiles
  const allProfile = getInstallProfile("all");
  assert.equal(allProfile.writeAgents, true);
  assert.equal(allProfile.writeVSCode, true);
  assert.equal(allProfile.writeAntigravity, true);
});

test("install profile skips descriptors whose profile predicate is false", () => {
  // opencode profile does not set writeVSCode
  const openProfile = getInstallProfile("opencode");
  assert.equal(openProfile.writeVSCode, false);
  assert.equal(openProfile.writeAntigravity, false);
  assert.equal(openProfile.writeClaudeDesktop, false);
  // but does set writeOpenCode and writeAgents
  assert.equal(openProfile.writeOpenCode, true);
  assert.equal(openProfile.writeAgents, true);
});

test("verify function receives correct context shape", async () => {
  // Test that the verify callback is called with the expected argument shape
  const fakeDef = INSTALL_HOST_DEFINITIONS["codex"];
  let receivedContext = null;

  // Create a wrapper to capture the context
  const originalVerify = fakeDef.verify;
  const fakeChecks = [];
  const fakeAssetPaths = { agentsInstructionsPath: "/tmp/nonexistent" };
  const fakeCollect = async (checks, id, fn) => {
    checks.push({ id, status: "skipped" });
  };

  try {
    await originalVerify.call(fakeDef, {
      checks: fakeChecks,
      root: "/tmp",
      assetPaths: fakeAssetPaths,
      collectVerifyCheck: fakeCollect,
    });
  } catch {
    // verify may throw since paths don't exist -- that's fine for this test
  }

  // The verify function should have attempted to collect at least one check
  assert.ok(
    fakeChecks.length > 0,
    "codex verify should collect at least one check via collectVerifyCheck",
  );
  assert.equal(fakeChecks[0].id, "codex_global_surface");
});
