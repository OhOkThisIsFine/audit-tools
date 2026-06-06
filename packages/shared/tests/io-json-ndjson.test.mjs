import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  appendNdjsonFile,
  readNdjsonFile,
  writeNdjsonFile,
  readOptionalNdjsonFile,
  readOptionalTextFile,
  writeTextFile,
} = await import("../src/io/json.ts");

// ── appendNdjsonFile ──────────────────────────────────────────────────────────

test("appendNdjsonFile appends one JSON record per call and file ends with newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "out.ndjson");
    await appendNdjsonFile(path, { a: 1 });
    await appendNdjsonFile(path, { b: 2 });
    const records = await readNdjsonFile(path);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { a: 1 });
    assert.deepEqual(records[1], { b: 2 });
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n"), "file should end with a newline");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendNdjsonFile creates parent directories if they do not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "nested", "subdir", "out.ndjson");
    await appendNdjsonFile(path, { x: 42 });
    const records = await readNdjsonFile(path);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], { x: 42 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── readNdjsonFile ────────────────────────────────────────────────────────────

test("readNdjsonFile round-trips records written by appendNdjsonFile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "records.ndjson");
    const originals = [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }];
    for (const rec of originals) {
      await appendNdjsonFile(path, rec);
    }
    const result = await readNdjsonFile(path);
    assert.deepEqual(result, originals);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNdjsonFile skips blank lines without error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "blanks.ndjson");
    // Write NDJSON manually with blank lines interspersed
    await writeFile(
      path,
      '{"n":1}\n\n{"n":2}\n   \n{"n":3}\n',
      "utf8",
    );
    const records = await readNdjsonFile(path);
    assert.deepEqual(records, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNdjsonFile throws on whitespace-only content (sentinel guard)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "whitespace.ndjson");
    await writeTextFile(path, "   \n  \n  ");
    await assert.rejects(
      readNdjsonFile(path),
      (err) => {
        assert.ok(
          err instanceof Error && err.message.includes("only whitespace"),
          `Expected 'only whitespace' in message, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNdjsonFile throws on invalid JSON line with line number in message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "bad.ndjson");
    await writeFile(path, '{"ok":true}\nnot-json\n', "utf8");
    await assert.rejects(
      readNdjsonFile(path),
      (err) => {
        assert.ok(
          err instanceof Error && err.message.includes("line 2"),
          `Expected 'line 2' in message, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNdjsonFile rethrows ENOENT directly (does not wrap it)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "nonexistent.ndjson");
    await assert.rejects(
      readNdjsonFile(path),
      (err) => {
        assert.equal(err.code, "ENOENT");
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── writeNdjsonFile ───────────────────────────────────────────────────────────

test("writeNdjsonFile round-trips an array of records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "written.ndjson");
    const originals = [{ x: 1 }, { x: 2 }, { x: 3 }];
    await writeNdjsonFile(path, originals);
    const result = await readNdjsonFile(path);
    assert.deepEqual(result, originals);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeNdjsonFile with empty array produces empty file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "empty.ndjson");
    await writeNdjsonFile(path, []);
    const raw = await readFile(path, "utf8");
    assert.equal(raw, "");
    const result = await readNdjsonFile(path);
    assert.deepEqual(result, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── readOptionalNdjsonFile ────────────────────────────────────────────────────

test("readOptionalNdjsonFile returns undefined for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const result = await readOptionalNdjsonFile(join(dir, "missing.ndjson"));
    assert.equal(result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readOptionalNdjsonFile returns parsed records for an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "present.ndjson");
    await appendNdjsonFile(path, { k: "v" });
    const result = await readOptionalNdjsonFile(path);
    assert.deepEqual(result, [{ k: "v" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── readOptionalTextFile ──────────────────────────────────────────────────────

test("readOptionalTextFile returns undefined for a missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const result = await readOptionalTextFile(join(dir, "missing.txt"));
    assert.equal(result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readOptionalTextFile returns file content for an existing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "hello.txt");
    await writeTextFile(path, "hello world");
    const result = await readOptionalTextFile(path);
    assert.equal(result, "hello world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── writeTextFile ─────────────────────────────────────────────────────────────

test("writeTextFile persists a string atomically and creates parent directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-ndjson-"));
  try {
    const path = join(dir, "sub", "nested", "file.txt");
    await writeTextFile(path, "atomic content");
    const result = await readOptionalTextFile(path);
    assert.equal(result, "atomic content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
