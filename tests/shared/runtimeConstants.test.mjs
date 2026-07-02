import { test, describe, it, expect } from "vitest";

const { PROVIDER_NAMES, SESSION_UI_MODES, ANALYZER_SETTINGS } = await import("../../src/shared/types/sessionConfig.ts");
const { SURFACE_KINDS } = await import("../../src/shared/types/surfaces.ts");

describe("PROVIDER_NAMES contains the expected provider strings", () => {
  it("is an array", () => {
    expect(Array.isArray(PROVIDER_NAMES)).toBeTruthy();
  });

  it("contains 'auto'", () => {
    expect(PROVIDER_NAMES.includes("auto")).toBeTruthy();
  });

  it("contains 'local-subprocess'", () => {
    expect(PROVIDER_NAMES.includes("local-subprocess")).toBeTruthy();
  });

  it("contains 'subprocess-template'", () => {
    expect(PROVIDER_NAMES.includes("subprocess-template")).toBeTruthy();
  });

  it("contains 'claude-code'", () => {
    expect(PROVIDER_NAMES.includes("claude-code")).toBeTruthy();
  });

  it("contains 'codex'", () => {
    expect(PROVIDER_NAMES.includes("codex")).toBeTruthy();
  });

  it("contains 'opencode'", () => {
    expect(PROVIDER_NAMES.includes("opencode")).toBeTruthy();
  });

  it("contains 'openai-compatible'", () => {
    expect(PROVIDER_NAMES.includes("openai-compatible")).toBeTruthy();
  });

  it("contains 'vscode-task'", () => {
    expect(PROVIDER_NAMES.includes("vscode-task")).toBeTruthy();
  });

  it("contains 'antigravity'", () => {
    expect(PROVIDER_NAMES.includes("antigravity")).toBeTruthy();
  });

  it("has exactly 9 entries", () => {
    expect(PROVIDER_NAMES.length).toBe(9);
  });
});

describe("SESSION_UI_MODES contains the expected UI mode strings", () => {
  it("is an array", () => {
    expect(Array.isArray(SESSION_UI_MODES)).toBeTruthy();
  });

  it("contains 'visible'", () => {
    expect(SESSION_UI_MODES.includes("visible")).toBeTruthy();
  });

  it("contains 'headless'", () => {
    expect(SESSION_UI_MODES.includes("headless")).toBeTruthy();
  });

  it("has exactly 2 entries", () => {
    expect(SESSION_UI_MODES.length).toBe(2);
  });
});

describe("ANALYZER_SETTINGS contains the expected analyzer setting strings", () => {
  it("is an array", () => {
    expect(Array.isArray(ANALYZER_SETTINGS)).toBeTruthy();
  });

  it("contains 'repo'", () => {
    expect(ANALYZER_SETTINGS.includes("repo")).toBeTruthy();
  });

  it("contains 'ephemeral'", () => {
    expect(ANALYZER_SETTINGS.includes("ephemeral")).toBeTruthy();
  });

  it("contains 'permanent'", () => {
    expect(ANALYZER_SETTINGS.includes("permanent")).toBeTruthy();
  });

  it("contains 'skip'", () => {
    expect(ANALYZER_SETTINGS.includes("skip")).toBeTruthy();
  });

  it("contains 'auto'", () => {
    expect(ANALYZER_SETTINGS.includes("auto")).toBeTruthy();
  });

  it("has exactly 5 entries", () => {
    expect(ANALYZER_SETTINGS.length).toBe(5);
  });
});

describe("SURFACE_KINDS contains the expected surface kind strings", () => {
  it("is an array", () => {
    expect(Array.isArray(SURFACE_KINDS)).toBeTruthy();
  });

  it("contains 'interface'", () => {
    expect(SURFACE_KINDS.includes("interface")).toBeTruthy();
  });

  it("contains 'background'", () => {
    expect(SURFACE_KINDS.includes("background")).toBeTruthy();
  });

  it("has exactly 2 entries", () => {
    expect(SURFACE_KINDS.length).toBe(2);
  });
});
