import { describe, it, expect } from "vitest";
import {
  CODEX_DEFAULT_MAX_THREADS,
  readCodexConfiguredMaxThreads,
} from "../../src/shared/quota/codexHostConfig.ts";

/** A reader that returns fixed text for a path, or throws (file absent). */
function reader(text) {
  return () => {
    if (text === null) throw new Error("ENOENT");
    return text;
  };
}

describe("readCodexConfiguredMaxThreads", () => {
  it("reads [agents].max_threads from a valid config", () => {
    const value = readCodexConfiguredMaxThreads({
      readText: reader("[agents]\nmax_threads = 10\n"),
    });
    expect(value).toBe(10);
  });

  it("handles inline-table and dotted-key spellings (vetted TOML parser)", () => {
    expect(
      readCodexConfiguredMaxThreads({ readText: reader("agents = { max_threads = 4 }\n") }),
    ).toBe(4);
    expect(
      readCodexConfiguredMaxThreads({ readText: reader("agents.max_threads = 7\n") }),
    ).toBe(7);
  });

  it("returns null when the file is absent (caller applies the documented default)", () => {
    expect(readCodexConfiguredMaxThreads({ readText: reader(null) })).toBe(null);
  });

  it("returns null when [agents] or max_threads is missing", () => {
    expect(readCodexConfiguredMaxThreads({ readText: reader("[model]\nname = 'x'\n") })).toBe(null);
    expect(readCodexConfiguredMaxThreads({ readText: reader("[agents]\nmax_depth = 1\n") })).toBe(null);
  });

  it("degrades to null on malformed TOML (never throws)", () => {
    expect(readCodexConfiguredMaxThreads({ readText: reader("[agents\nmax_threads = ") })).toBe(null);
  });

  it("rejects non-positive-integer values", () => {
    expect(readCodexConfiguredMaxThreads({ readText: reader("[agents]\nmax_threads = 0\n") })).toBe(null);
    expect(readCodexConfiguredMaxThreads({ readText: reader("[agents]\nmax_threads = -3\n") })).toBe(null);
    expect(readCodexConfiguredMaxThreads({ readText: reader("[agents]\nmax_threads = 2.5\n") })).toBe(null);
    expect(readCodexConfiguredMaxThreads({ readText: reader('[agents]\nmax_threads = "6"\n') })).toBe(null);
  });

  it("exposes Codex's documented default constant", () => {
    expect(CODEX_DEFAULT_MAX_THREADS).toBe(6);
  });
});
