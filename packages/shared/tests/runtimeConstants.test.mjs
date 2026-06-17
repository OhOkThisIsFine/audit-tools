import test from "node:test";
import assert from "node:assert/strict";

const { PROVIDER_NAMES, SESSION_UI_MODES, ANALYZER_SETTINGS } = await import(
  "../src/types/sessionConfig.ts"
);
const { SURFACE_KINDS } = await import("../src/types/surfaces.ts");

test("PROVIDER_NAMES contains the expected provider strings", async (t) => {
  await t.test("is an array", () => {
    assert.ok(Array.isArray(PROVIDER_NAMES));
  });

  await t.test("contains 'auto'", () => {
    assert.ok(PROVIDER_NAMES.includes("auto"));
  });

  await t.test("contains 'local-subprocess'", () => {
    assert.ok(PROVIDER_NAMES.includes("local-subprocess"));
  });

  await t.test("contains 'subprocess-template'", () => {
    assert.ok(PROVIDER_NAMES.includes("subprocess-template"));
  });

  await t.test("contains 'claude-code'", () => {
    assert.ok(PROVIDER_NAMES.includes("claude-code"));
  });

  await t.test("contains 'codex'", () => {
    assert.ok(PROVIDER_NAMES.includes("codex"));
  });

  await t.test("contains 'opencode'", () => {
    assert.ok(PROVIDER_NAMES.includes("opencode"));
  });

  await t.test("contains 'openai-compatible'", () => {
    assert.ok(PROVIDER_NAMES.includes("openai-compatible"));
  });

  await t.test("contains 'vscode-task'", () => {
    assert.ok(PROVIDER_NAMES.includes("vscode-task"));
  });

  await t.test("contains 'antigravity'", () => {
    assert.ok(PROVIDER_NAMES.includes("antigravity"));
  });

  await t.test("has exactly 9 entries", () => {
    assert.equal(PROVIDER_NAMES.length, 9);
  });
});

test("SESSION_UI_MODES contains the expected UI mode strings", async (t) => {
  await t.test("is an array", () => {
    assert.ok(Array.isArray(SESSION_UI_MODES));
  });

  await t.test("contains 'visible'", () => {
    assert.ok(SESSION_UI_MODES.includes("visible"));
  });

  await t.test("contains 'headless'", () => {
    assert.ok(SESSION_UI_MODES.includes("headless"));
  });

  await t.test("has exactly 2 entries", () => {
    assert.equal(SESSION_UI_MODES.length, 2);
  });
});

test("ANALYZER_SETTINGS contains the expected analyzer setting strings", async (t) => {
  await t.test("is an array", () => {
    assert.ok(Array.isArray(ANALYZER_SETTINGS));
  });

  await t.test("contains 'repo'", () => {
    assert.ok(ANALYZER_SETTINGS.includes("repo"));
  });

  await t.test("contains 'ephemeral'", () => {
    assert.ok(ANALYZER_SETTINGS.includes("ephemeral"));
  });

  await t.test("contains 'permanent'", () => {
    assert.ok(ANALYZER_SETTINGS.includes("permanent"));
  });

  await t.test("contains 'skip'", () => {
    assert.ok(ANALYZER_SETTINGS.includes("skip"));
  });

  await t.test("contains 'auto'", () => {
    assert.ok(ANALYZER_SETTINGS.includes("auto"));
  });

  await t.test("has exactly 5 entries", () => {
    assert.equal(ANALYZER_SETTINGS.length, 5);
  });
});

test("SURFACE_KINDS contains the expected surface kind strings", async (t) => {
  await t.test("is an array", () => {
    assert.ok(Array.isArray(SURFACE_KINDS));
  });

  await t.test("contains 'interface'", () => {
    assert.ok(SURFACE_KINDS.includes("interface"));
  });

  await t.test("contains 'background'", () => {
    assert.ok(SURFACE_KINDS.includes("background"));
  });

  await t.test("has exactly 2 entries", () => {
    assert.equal(SURFACE_KINDS.length, 2);
  });
});
