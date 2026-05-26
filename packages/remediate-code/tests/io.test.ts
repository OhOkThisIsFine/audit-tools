import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJsonFile,
  writeJsonFile,
  readNdjsonFile,
  appendNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeTextFile,
  writeNdjsonFile,
  readOptionalTextFile,
  isFileMissingError,
} from "../src/io/json.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-io");

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("readJsonFile", () => {
  it("reads a valid JSON file", async () => {
    const p = join(TEST_DIR, "a.json");
    await writeFile(p, JSON.stringify({ x: 1 }), "utf8");
    expect(await readJsonFile<{ x: number }>(p)).toEqual({ x: 1 });
  });

  it("throws with ENOENT code for missing file", async () => {
    const err = await readJsonFile(join(TEST_DIR, "missing.json")).catch(
      (e) => e,
    );
    expect(isFileMissingError(err)).toBe(true);
  });

  it("throws a descriptive error for malformed JSON", async () => {
    const p = join(TEST_DIR, "bad.json");
    await writeFile(p, "{not valid json}", "utf8");
    await expect(readJsonFile(p)).rejects.toThrow(/Invalid JSON/);
  });
});

describe("writeJsonFile / readJsonFile roundtrip", () => {
  it("roundtrips an object", async () => {
    const p = join(TEST_DIR, "obj.json");
    const obj = { a: 1, b: [1, 2, 3], c: true };
    await writeJsonFile(p, obj);
    expect(await readJsonFile(p)).toEqual(obj);
  });

  it("creates parent directory if missing", async () => {
    const p = join(TEST_DIR, "nested", "dir", "file.json");
    await writeJsonFile(p, { hello: "world" });
    expect(await readJsonFile(p)).toEqual({ hello: "world" });
  });
});

describe("readNdjsonFile", () => {
  it("reads multiple records", async () => {
    const p = join(TEST_DIR, "data.ndjson");
    await writeFile(p, '{"a":1}\n{"b":2}\n', "utf8");
    expect(await readNdjsonFile(p)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips blank lines", async () => {
    const p = join(TEST_DIR, "blanks.ndjson");
    await writeFile(p, '{"a":1}\n\n{"b":2}\n\n', "utf8");
    expect(await readNdjsonFile(p)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("throws for whitespace-only file (possible truncated write)", async () => {
    const p = join(TEST_DIR, "ws.ndjson");
    await writeFile(p, "   \n  \n", "utf8");
    await expect(readNdjsonFile(p)).rejects.toThrow(/only whitespace/);
  });

  it("returns empty array for genuinely empty file", async () => {
    const p = join(TEST_DIR, "empty.ndjson");
    await writeFile(p, "", "utf8");
    expect(await readNdjsonFile(p)).toEqual([]);
  });

  it("throws with ENOENT code for missing file", async () => {
    const err = await readNdjsonFile(join(TEST_DIR, "missing.ndjson")).catch(
      (e) => e,
    );
    expect(isFileMissingError(err)).toBe(true);
  });

  it("throws on malformed JSON line", async () => {
    const p = join(TEST_DIR, "bad.ndjson");
    await writeFile(p, '{"a":1}\nbadline\n', "utf8");
    await expect(readNdjsonFile(p)).rejects.toThrow(/Invalid NDJSON/);
  });
});

describe("appendNdjsonFile", () => {
  it("appends records to existing file", async () => {
    const p = join(TEST_DIR, "append.ndjson");
    await appendNdjsonFile(p, { x: 1 });
    await appendNdjsonFile(p, { x: 2 });
    expect(await readNdjsonFile(p)).toEqual([{ x: 1 }, { x: 2 }]);
  });
});

describe("writeNdjsonFile", () => {
  it("writes records in ndjson format", async () => {
    const p = join(TEST_DIR, "written.ndjson");
    await writeNdjsonFile(p, [{ x: 1 }, { y: 2 }]);
    expect(await readNdjsonFile(p)).toEqual([{ x: 1 }, { y: 2 }]);
  });

  it("writes an empty file for an empty record set", async () => {
    const p = join(TEST_DIR, "empty-written.ndjson");
    await writeNdjsonFile(p, []);
    expect(await readNdjsonFile(p)).toEqual([]);
  });
});

describe("readOptionalJsonFile", () => {
  it("returns undefined for missing file", async () => {
    expect(
      await readOptionalJsonFile(join(TEST_DIR, "missing.json")),
    ).toBeUndefined();
  });

  it("returns the value for existing file", async () => {
    const p = join(TEST_DIR, "opt.json");
    await writeJsonFile(p, { y: 42 });
    expect(await readOptionalJsonFile(p)).toEqual({ y: 42 });
  });
});

describe("readOptionalNdjsonFile", () => {
  it("returns undefined for missing file", async () => {
    expect(
      await readOptionalNdjsonFile(join(TEST_DIR, "missing.ndjson")),
    ).toBeUndefined();
  });
});

describe("writeTextFile", () => {
  it("writes and can be read back", async () => {
    const p = join(TEST_DIR, "text.txt");
    await writeTextFile(p, "hello world");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(p, "utf8")).toBe("hello world");
  });
});

describe("readOptionalTextFile", () => {
  it("returns undefined for a missing text file", async () => {
    expect(
      await readOptionalTextFile(join(TEST_DIR, "missing.txt")),
    ).toBeUndefined();
  });

  it("reads an existing text file", async () => {
    const p = join(TEST_DIR, "existing.txt");
    await writeTextFile(p, "hello");
    expect(await readOptionalTextFile(p)).toBe("hello");
  });
});

describe("isFileMissingError", () => {
  it("returns true for ENOENT error", () => {
    expect(isFileMissingError({ code: "ENOENT" })).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isFileMissingError({ code: "EACCES" })).toBe(false);
    expect(isFileMissingError(new Error("something else"))).toBe(false);
    expect(isFileMissingError(null)).toBe(false);
  });
});
