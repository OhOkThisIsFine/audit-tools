import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  writeJsonFile,
  readJsonFile,
  readJsonStringScalar,
  readJsonStringScalarChunks,
  appendNdjsonFile,
  readNdjsonFile,
} = await import('../../src/shared/io/json.ts');

// ── F-7: container wrapping is ALREADY handled (writeJsonFile 2-space-indents) ──

test('writeJsonFile already 2-space-indents containers (run-results.json compliant)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-container-'));
  try {
    const path = join(dir, 'run-results.json');
    const value = { results: [{ id: 'a', nested: { ok: true } }], count: 1 };
    await writeJsonFile(path, value);
    const raw = await readFile(path, 'utf8');
    // Indentation is present: nested keys are wrapped onto their own indented lines.
    expect(raw.includes('\n  "results"'), 'top-level key indented by 2 spaces').toBeTruthy();
    expect(raw.includes('\n      "id"'), 'array-element key indented further').toBeTruthy();
    // Exactly the canonical 2-space serialization — no redundant re-indent.
    expect(raw).toBe(JSON.stringify(value, null, 2) + '\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── F-7 genuine residual: an over-cap (>2000-char) SCALAR string a worker re-reads ──

test('readJsonStringScalar reconstructs an over-cap (>2000-char) scalar in full', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-scalar-'));
  try {
    const path = join(dir, 'audit-result.json');
    // A single quoted_text scalar far longer than the host Read line cap (~2000).
    const longScalar = 'x'.repeat(5000);
    await writeJsonFile(path, {
      findings: [{ id: 'F-1', evidence: { quoted_text: longScalar } }],
    });

    // The serialized scalar lives on ONE physical line — indentation cannot wrap it,
    // so a line-truncating reader would clip it. Confirm that pathology exists.
    const raw = await readFile(path, 'utf8');
    const longestLine = Math.max(...raw.split('\n').map((l) => l.length));
    expect(longestLine > 2000, `the scalar should produce an over-cap line (got longest ${longestLine})`).toBeTruthy();

    // The bounded accessor parses the file (no per-line cap) and returns it whole.
    const value = await readJsonStringScalar(path, [
      'findings',
      '0',
      'evidence',
      'quoted_text',
    ]);
    expect(value).toBe(longScalar);
    expect(value?.length).toBe(5000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonStringScalarChunks streams an over-cap scalar in bounded chunks that re-concat exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-chunks-'));
  try {
    const path = join(dir, 'audit-result.json');
    const longScalar = Array.from({ length: 5000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join('');
    await writeJsonFile(path, { evidence: { base64: longScalar } });

    const chunks = [];
    for await (const chunk of readJsonStringScalarChunks(
      path,
      ['evidence', 'base64'],
      1000,
    )) {
      expect(chunk.length <= 1000, 'no chunk exceeds the bounded chunk size').toBeTruthy();
      chunks.push(chunk);
    }
    expect(chunks.length, '5000 chars / 1000 = 5 bounded chunks').toBe(5);
    expect(chunks.join(''), 'chunks re-concatenate exactly').toBe(longScalar);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonStringScalar round-trips an arbitrary scalar through write→read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-roundtrip-'));
  try {
    const path = join(dir, 'rt.json');
    // Awkward characters that must survive JSON encode/decode unchanged.
    const scalar = 'line1\nline2\t"quoted" \\backslash\\ é\u{1f600} ' + 'z'.repeat(3000);
    await writeJsonFile(path, { a: { b: { c: scalar } } });

    const direct = await readJsonStringScalar(path, ['a', 'b', 'c']);
    expect(direct, 'scalar accessor round-trips exactly').toBe(scalar);

    // Full-document round-trip stays intact too.
    const whole = await readJsonFile(path);
    expect(whole.a.b.c).toBe(scalar);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJsonStringScalar returns undefined for a missing path or a non-string value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-undef-'));
  try {
    const path = join(dir, 'u.json');
    await writeJsonFile(path, { a: { count: 42 }, list: ['only'] });

    expect(await readJsonStringScalar(path, ['a', 'missing'])).toBe(undefined);
    expect(await readJsonStringScalar(path, ['a', 'count']), 'number is not a string scalar').toBe(undefined);
    expect(await readJsonStringScalar(path, ['list', '5']), 'out-of-range index').toBe(undefined);
    expect(await readJsonStringScalar(path, ['list', '0'])).toBe('only');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── invariant: the NDJSON/JSONL appender path stays line-delimited & untouched ──

test('NDJSON appender stays single-line per record (not reformatted)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'json-io-jsonl-'));
  try {
    const path = join(dir, 'results.jsonl');
    await appendNdjsonFile(path, { id: 'a', nested: { deep: [1, 2, 3] } });
    await appendNdjsonFile(path, { id: 'b', nested: { deep: [4, 5, 6] } });

    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines.length, 'one JSON record per physical line').toBe(2);
    // No indentation injected into the JSONL records.
    expect(!raw.includes('\n  '), 'records are compact, not 2-space-indented').toBeTruthy();
    for (const line of lines) {
      // Each line is itself a complete, parseable JSON document.
      JSON.parse(line);
    }
    const records = await readNdjsonFile(path);
    expect(records).toEqual([
      { id: 'a', nested: { deep: [1, 2, 3] } },
      { id: 'b', nested: { deep: [4, 5, 6] } },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
