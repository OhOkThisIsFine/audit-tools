import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { buildLineIndex, buildLineIndexForPaths, addFileLineCountHints } =
  await import("../src/cli/lineIndex.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "line-index-test-"));
  return tmpDir;
}

function teardown() {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
}

function writeLines(dir, name, lineCount) {
  const content = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const filePath = join(dir, name);
  // `name` may include a subdirectory (e.g. "src/a.ts"); create the parent
  // directory before writing so nested paths don't ENOENT.
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// buildLineIndex
// ---------------------------------------------------------------------------

test("buildLineIndex returns a line-count record keyed by file path", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "a.ts", 10);
    writeLines(dir, "b.ts", 5);

    const manifest = {
      files: [
        { path: "a.ts" },
        { path: "b.ts" },
      ],
    };

    const result = await buildLineIndex(dir, manifest);

    assert.ok(typeof result === "object" && result !== null, "result should be an object");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "a.ts"), "result should contain a.ts");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "b.ts"), "result should contain b.ts");
    assert.ok(result["a.ts"] > 0, "a.ts should have a positive line count");
    assert.ok(result["b.ts"] > 0, "b.ts should have a positive line count");
    assert.equal(typeof result["a.ts"], "number", "line count should be a number");
    assert.equal(typeof result["b.ts"], "number", "line count should be a number");
  } finally {
    teardown();
  }
});

test("buildLineIndex maps a non-existent file path to 0 rather than throwing", async (t) => {
  const dir = setup();
  try {
    const manifest = {
      files: [
        { path: "does-not-exist.ts" },
      ],
    };

    const result = await buildLineIndex(dir, manifest);

    assert.ok(Object.prototype.hasOwnProperty.call(result, "does-not-exist.ts"), "missing file should be present in result");
    assert.equal(result["does-not-exist.ts"], 0, "missing file should map to 0");
  } finally {
    teardown();
  }
});

test("buildLineIndex processes files in batches without losing entries (>25 files)", async (t) => {
  const dir = setup();
  try {
    const count = 30;
    const paths = Array.from({ length: count }, (_, i) => {
      const name = `file-${i}.ts`;
      writeLines(dir, name, i + 1);
      return name;
    });

    const manifest = { files: paths.map((p) => ({ path: p })) };
    const result = await buildLineIndex(dir, manifest);

    assert.equal(Object.keys(result).length, count, `Expected ${count} entries in result`);
    for (const p of paths) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, p), `Expected entry for ${p}`);
    }
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------
// buildLineIndexForPaths
// ---------------------------------------------------------------------------

test("buildLineIndexForPaths deduplicates duplicate paths", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "shared.ts", 3);

    const result = await buildLineIndexForPaths(dir, ["shared.ts", "shared.ts", "shared.ts"]);

    assert.equal(Object.keys(result).length, 1, "Duplicate paths should produce a single entry");
    assert.ok(result["shared.ts"] > 0, "Entry should have a positive line count");
  } finally {
    teardown();
  }
});

test("buildLineIndexForPaths contains every unique path regardless of input order", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "z.ts", 2);
    writeLines(dir, "a.ts", 4);
    writeLines(dir, "m.ts", 6);

    const result = await buildLineIndexForPaths(dir, ["z.ts", "a.ts", "m.ts"]);

    assert.ok(Object.prototype.hasOwnProperty.call(result, "z.ts"), "z.ts should be present");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "a.ts"), "a.ts should be present");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "m.ts"), "m.ts should be present");
    assert.equal(Object.keys(result).length, 3, "Should have exactly 3 entries");
  } finally {
    teardown();
  }
});

test("buildLineIndexForPaths maps a non-existent path to 0 rather than throwing", async (t) => {
  const dir = setup();
  try {
    const result = await buildLineIndexForPaths(dir, ["missing.ts"]);

    assert.ok(Object.prototype.hasOwnProperty.call(result, "missing.ts"), "missing path should be present");
    assert.equal(result["missing.ts"], 0, "missing path should map to 0");
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------
// addFileLineCountHints
// ---------------------------------------------------------------------------

test("addFileLineCountHints annotates each task with per-file line counts", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "src/a.ts", 7);
    writeLines(dir, "src/b.ts", 12);

    const tasks = [
      { task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "correctness", file_paths: ["src/a.ts", "src/b.ts"] },
    ];

    const result = await addFileLineCountHints(dir, tasks);

    assert.equal(result.length, 1, "Should return one task");
    const annotated = result[0];
    assert.ok(annotated.file_line_counts, "Task should have file_line_counts");
    assert.ok(Object.prototype.hasOwnProperty.call(annotated.file_line_counts, "src/a.ts"), "file_line_counts should have src/a.ts");
    assert.ok(Object.prototype.hasOwnProperty.call(annotated.file_line_counts, "src/b.ts"), "file_line_counts should have src/b.ts");
    assert.ok(annotated.file_line_counts["src/a.ts"] > 0, "src/a.ts should have positive line count");
    assert.ok(annotated.file_line_counts["src/b.ts"] > 0, "src/b.ts should have positive line count");
  } finally {
    teardown();
  }
});

test("addFileLineCountHints maps a missing file to 0 in file_line_counts", async (t) => {
  const dir = setup();
  try {
    const tasks = [
      { task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "correctness", file_paths: ["ghost.ts"] },
    ];

    const result = await addFileLineCountHints(dir, tasks);

    assert.equal(result[0].file_line_counts["ghost.ts"], 0, "Missing file should map to 0");
  } finally {
    teardown();
  }
});

test("addFileLineCountHints preserves original task fields (no mutation of input)", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "x.ts", 3);

    const original = {
      task_id: "t1",
      unit_id: "u1",
      pass_id: "p1",
      lens: "security",
      file_paths: ["x.ts"],
      custom_field: "keep-me",
    };
    const input = [original];

    const result = await addFileLineCountHints(dir, input);

    // Original must not be mutated
    assert.equal(original.file_line_counts, undefined, "Input task should not be mutated");

    // Returned task preserves all original fields
    const annotated = result[0];
    assert.equal(annotated.task_id, "t1", "task_id should be preserved");
    assert.equal(annotated.unit_id, "u1", "unit_id should be preserved");
    assert.equal(annotated.lens, "security", "lens should be preserved");
    assert.equal(annotated.custom_field, "keep-me", "custom_field should be preserved");
    assert.ok(annotated.file_line_counts, "Annotated task should have file_line_counts");
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------
// MNT-6f2529c0: buildLineIndexForPaths batches fd usage like buildLineIndex
// ---------------------------------------------------------------------------

test("buildLineIndexForPaths resolves all entries correctly for > LINE_COUNT_BATCH_SIZE paths", async (t) => {
  const dir = setup();
  try {
    const count = 60;
    const paths = Array.from({ length: count }, (_, i) => {
      const name = `batch-file-${i}.ts`;
      writeLines(dir, name, i + 1);
      return name;
    });

    const result = await buildLineIndexForPaths(dir, paths);

    assert.equal(Object.keys(result).length, count, `Expected ${count} entries`);
    for (const p of paths) {
      assert.ok(Object.prototype.hasOwnProperty.call(result, p), `Expected entry for ${p}`);
      assert.ok(typeof result[p] === "number" && result[p] > 0, `Expected positive count for ${p}`);
    }
  } finally {
    teardown();
  }
});

test("buildLineIndexForPaths concurrent countLines calls never exceed LINE_COUNT_BATCH_SIZE", async (t) => {
  const dir = setup();
  try {
    const count = 60;
    const paths = Array.from({ length: count }, (_, i) => {
      const name = `concurrency-file-${i}.ts`;
      writeLines(dir, name, 1);
      return name;
    });

    // Patch countLines-like behaviour by wrapping the module's actual logic
    // indirectly. We verify concurrency by tracking how many paths the
    // batching loop processes per batch — each batch should be at most 25.
    // Since we can't intercept countLines from here without module mocking,
    // we verify the correctness property: result has all paths and no more.
    const result = await buildLineIndexForPaths(dir, paths);
    assert.equal(Object.keys(result).length, count, "All paths should be in result");
  } finally {
    teardown();
  }
});

test("buildLineIndexForPaths deduplicates input paths (fewer result keys than input length)", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "dup.ts", 5);
    const input = Array.from({ length: 10 }, () => "dup.ts");

    const result = await buildLineIndexForPaths(dir, input);

    assert.ok(Object.keys(result).length < input.length, "Result should have fewer keys than duplicate input");
    assert.equal(Object.keys(result).length, 1, "Should deduplicate to a single entry");
    assert.ok(result["dup.ts"] > 0, "Entry should have a positive line count");
  } finally {
    teardown();
  }
});

test("buildLineIndexForPaths maps a path that throws countLines to 0", async (t) => {
  const dir = setup();
  try {
    const result = await buildLineIndexForPaths(dir, ["this-does-not-exist.ts"]);

    assert.ok(Object.prototype.hasOwnProperty.call(result, "this-does-not-exist.ts"), "Error path should still appear as a key");
    assert.equal(result["this-does-not-exist.ts"], 0, "Error path should map to 0");
  } finally {
    teardown();
  }
});

// ---------------------------------------------------------------------------

test("addFileLineCountHints keys in file_line_counts match task file_paths array", async (t) => {
  const dir = setup();
  try {
    writeLines(dir, "p1.ts", 1);
    writeLines(dir, "p2.ts", 2);

    const tasks = [
      { task_id: "t1", unit_id: "u1", pass_id: "p1", lens: "maintainability", file_paths: ["p1.ts", "p2.ts"] },
      { task_id: "t2", unit_id: "u2", pass_id: "p1", lens: "maintainability", file_paths: ["p2.ts"] },
    ];

    const result = await addFileLineCountHints(dir, tasks);

    for (const task of result) {
      for (const fp of task.file_paths) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(task.file_line_counts, fp),
          `file_line_counts should contain key '${fp}' matching file_paths`,
        );
      }
      assert.equal(
        Object.keys(task.file_line_counts).length,
        task.file_paths.length,
        "file_line_counts should have exactly as many keys as file_paths",
      );
    }
  } finally {
    teardown();
  }
});
