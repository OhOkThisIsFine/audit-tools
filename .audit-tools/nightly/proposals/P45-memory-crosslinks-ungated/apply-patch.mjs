#!/usr/bin/env node
/**
 * P45 — apply the memory cross-link half to `scripts/check-memory-citations.mjs`.
 *
 * Deterministic and idempotent: it refuses if the anchors are gone (the gate moved
 * under it) and exits 0 with a notice if the block is already present.
 *
 * Run from the repo root:  node .audit-tools/nightly/proposals/P45-memory-crosslinks-ungated/apply-patch.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "scripts/check-memory-citations.mjs";
const MARKER = "const WIKILINK =";

const ANCHOR_REPORT = "if (dangling.length > 0) {";
const ANCHOR_LOOP = "for (const { file, line, name } of dangling) {";
const ANCHOR_LINE = '    console.error(`  ${file}:${line || "?"} → memory: ${name}`);';

const BLOCK = String.raw`// The OTHER citation form. Memories cite each other as ` + "`[[name]]`" + String.raw`, and a dangling
// one fails exactly the way a dangling ` + "`memory:`" + String.raw` citation does — a pointer nobody can
// follow re-asserting whatever the deleted note said. It was structurally invisible
// to this gate, which is what made every prune of the store a hand-audit.
const WIKILINK = /\[\[([^\][|]+)\]\]/g;

/** Inline code and fenced blocks quote the SYNTAX; they document the form, not a target. */
function stripCodeSpans(text) {
  return text.replace(/` + "```" + String.raw`[\s\S]*?` + "```" + String.raw`/g, "").replace(/` + "`" + String.raw`[^` + "`" + String.raw`\n]*` + "`" + String.raw`/g, "");
}

for (const note of readdirSync(memoryDir).filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(join(memoryDir, note), "utf8");
  const lines = text.split(/\r?\n/);
  for (const match of stripCodeSpans(text).matchAll(WIKILINK)) {
    // A stray ` + "`.md`" + String.raw` suffix is a misspelling of a real target, not a second kind
    // of link — resolve the note first, then judge whether that note exists.
    const name = match[1].trim().replace(/\.md$/, "");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue;
    if (known.has(name)) continue;
    const line = lines.findIndex((l) => l.includes(match[1])) + 1;
    dangling.push({ file: join(memoryDir, note), line, name, form: "[[…]]" });
  }
}

`;

let text = readFileSync(TARGET, "utf8");

if (text.includes(MARKER)) {
  console.log("P45: already applied — nothing to do.");
  process.exit(0);
}

for (const anchor of [ANCHOR_REPORT, ANCHOR_LOOP, ANCHOR_LINE]) {
  if (!text.includes(anchor)) {
    console.error(`P45: anchor missing from ${TARGET}:\n  ${anchor}\nThe gate moved; re-derive the patch.`);
    process.exit(1);
  }
}

text = text.replace(ANCHOR_REPORT, BLOCK + ANCHOR_REPORT);
text = text.replace(ANCHOR_LOOP, "for (const { file, line, name, form } of dangling) {");
text = text.replace(ANCHOR_LINE, '    console.error(`  ${file}:${line || "?"} → ${form ?? "memory:"} ${name}`);');

writeFileSync(TARGET, text);
console.log(`P45: applied to ${TARGET}`);
