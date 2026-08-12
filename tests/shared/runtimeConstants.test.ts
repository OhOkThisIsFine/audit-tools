import { describe, it, expect } from "vitest";

const { ANALYZER_SETTINGS } = await import("../../src/shared/analyzerPolicy.js");
const { SURFACE_KINDS } = await import("../../src/shared/types/surfaces.js");

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
