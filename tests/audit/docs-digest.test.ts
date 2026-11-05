import { test, expect } from "vitest";
import { buildDocsDigest } from "../../src/audit/extractors/docsDigest.js";
import type { FileDisposition } from "audit-tools/shared";

// Map-backed reader (posix keys relative to the fixture root), mirroring the
// comment-decomposition test harness — no filesystem involved.
function readerFor(files: Record<string, string>) {
  return async (absPath: string): Promise<string | undefined> => {
    const rel = absPath.replace(/\\/g, "/").replace(/^\/repo\//, "");
    return files[rel];
  };
}

function disposition(files: Array<{ path: string; status: string }>): FileDisposition {
  return { files } as FileDisposition;
}

await test("buildDocsDigest selects the doc universe via the single doc predicate and orders depth-then-path", async () => {
  const digest = await buildDocsDigest({
    root: "/repo",
    disposition: disposition([
      { path: "docs/guide.md", status: "doc_only" },
      { path: "README.md", status: "included" },
      { path: "src/a.ts", status: "included" },
      { path: "notes.txt", status: "doc_only" },
      { path: "assets/logo.png", status: "binary" },
      { path: "vendor/readme.md", status: "excluded" },
    ]),
    readFileText: readerFor({
      "README.md": "# Fixture Project\n\nAudits codebases.",
      "docs/guide.md": "# Guide\n\nHow to run an audit.",
      "notes.txt": "loose notes with no heading",
    }),
  });

  // excluded/binary never enter the universe; depth-then-path puts root docs
  // first (code-unit order within a depth: "README" < "notes").
  expect(digest.docs.map((d) => d.path)).toEqual([
    "README.md",
    "notes.txt",
    "docs/guide.md",
  ]);
  expect(digest.docs[0].title).toBe("Fixture Project");
  expect(digest.docs[0].excerpt).toContain("Audits codebases.");
  // A doc without an ATX heading titles as its file name.
  expect(digest.docs[1].title).toBe("notes.txt");
  expect(digest.omitted_paths).toBeUndefined();
});

await test("buildDocsDigest leaves license files out: legal text is not the repository's purpose", async () => {
  const digest = await buildDocsDigest({
    root: "/repo",
    disposition: disposition([
      { path: "LICENSE", status: "doc_only" },
      { path: "LICENSE.md", status: "doc_only" },
      { path: "LICENSE-MIT", status: "doc_only" },
      { path: "LICENSE-APACHE.txt", status: "doc_only" },
      { path: "LICENCE", status: "doc_only" },
      { path: "COPYING", status: "doc_only" },
      { path: "COPYING.LESSER", status: "doc_only" },
      { path: "docs/licensing-faq.md", status: "doc_only" },
      { path: "README.md", status: "included" },
    ]),
    readFileText: readerFor({
      LICENSE: "ISC License\n\nPermission to use, copy, modify...",
      "LICENSE.md": "# MIT License",
      "LICENSE-MIT": "MIT License",
      "LICENSE-APACHE.txt": "Apache License",
      LICENCE: "MIT Licence",
      COPYING: "GNU GENERAL PUBLIC LICENSE",
      "COPYING.LESSER": "GNU LESSER GENERAL PUBLIC LICENSE",
      "docs/licensing-faq.md": "# Licensing FAQ",
      "README.md": "# Fixture\n\nAudits codebases.",
    }),
  });
  expect(digest.docs.map((d) => d.path)).toEqual(["README.md", "docs/licensing-faq.md"]);
  expect(digest.omitted_paths).toBeUndefined();
});

await test("buildDocsDigest caps the selection and records omitted paths; unreadable docs are skipped", async () => {
  const digest = await buildDocsDigest({
    root: "/repo",
    maxDocs: 1,
    disposition: disposition([
      { path: "README.md", status: "included" },
      { path: "CHANGES.md", status: "included" },
      { path: "docs/guide.md", status: "doc_only" },
    ]),
    readFileText: readerFor({
      // CHANGES.md is deliberately absent from the reader → skipped, not thrown.
      "README.md": "# Fixture\n\nBody.",
      "docs/guide.md": "# Guide",
    }),
  });
  // Depth-then-path selection order is CHANGES.md first (root, "C" < "R"); it
  // is unreadable so it is skipped (neither digested nor omitted), README.md
  // fills the single slot, and the rest of the universe lands in omitted_paths.
  expect(digest.docs.map((d) => d.path)).toEqual(["README.md"]);
  expect(digest.omitted_paths).toEqual(["docs/guide.md"]);
});

await test("buildDocsDigest caps each excerpt on a line boundary", async () => {
  const longLine = "x".repeat(120);
  const body = Array.from({ length: 20 }, () => longLine).join("\n");
  const digest = await buildDocsDigest({
    root: "/repo",
    maxExcerptChars: 300,
    disposition: disposition([{ path: "README.md", status: "included" }]),
    readFileText: readerFor({ "README.md": `# T\n\n${body}` }),
  });
  expect(digest.docs[0].excerpt.length).toBeLessThanOrEqual(300);
  expect(digest.docs[0].excerpt.endsWith(longLine)).toBe(true);
});

await test("buildDocsDigest strips a UTF-8 BOM and skips fenced pseudo-headings when titling (review findings)", async () => {
  const digest = await buildDocsDigest({
    root: "/repo",
    disposition: disposition([
      { path: "BOM.md", status: "included" },
      { path: "FENCE.md", status: "included" },
    ]),
    readFileText: readerFor({
      "BOM.md": "﻿# Bommed Title\n\nBody.",
      "FENCE.md": "intro prose\n\n```markdown\n# Not The Title\n```\n\n# Real Title\n\nBody.",
    }),
  });
  const byPath = Object.fromEntries(digest.docs.map((d) => [d.path, d]));
  expect(byPath["BOM.md"].title).toBe("Bommed Title");
  expect(byPath["BOM.md"].excerpt.startsWith("#")).toBe(true);
  expect(byPath["FENCE.md"].title).toBe("Real Title");
});

await test("buildDocsDigest degrades to an empty digest without a root", async () => {
  const digest = await buildDocsDigest({
    disposition: disposition([{ path: "README.md", status: "included" }]),
  });
  expect(digest.docs).toEqual([]);
  expect(digest.omitted_paths).toBeUndefined();
});
