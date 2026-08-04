import { describe, it, expect } from "vitest";
import { readCodexConfiguredMaxThreads } from "../../src/shared/quota/codexHostConfig.js";

/** A reader that returns fixed text for a path, or throws (file absent). */
function reader(text: string | null): () => string {
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

  it("reads the current max_concurrent_threads_per_session key", () => {
    const value = readCodexConfiguredMaxThreads({
      readText: reader("[agents]\nmax_concurrent_threads_per_session = 12\n"),
    });
    expect(value).toBe(12);
  });

  it("prefers the current key over the legacy alias", () => {
    const value = readCodexConfiguredMaxThreads({
      readText: reader(
        "[agents]\nmax_concurrent_threads_per_session = 12\nmax_threads = 6\n",
      ),
    });
    expect(value).toBe(12);
  });

  it("handles inline-table and dotted-key spellings (vetted TOML parser)", () => {
    expect(
      readCodexConfiguredMaxThreads({ readText: reader("agents = { max_threads = 4 }\n") }),
    ).toBe(4);
    expect(
      readCodexConfiguredMaxThreads({ readText: reader("agents.max_threads = 7\n") }),
    ).toBe(7);
  });

  it("returns null when the file is absent", () => {
    expect(readCodexConfiguredMaxThreads({ readText: reader(null) })).toBe(null);
  });

  it("returns null when [agents] or either concurrency key is missing", () => {
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

});
