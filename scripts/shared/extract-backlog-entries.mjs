#!/usr/bin/env node
// Extract docs/backlog.md into a machine-readable entry index.
// One record per top-level `- **…` bullet, with its section, line range and full text.
// Used to fan out per-entry HEAD verification; regenerate rather than hand-maintain.
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2] ?? "docs/backlog.md";
const out = process.argv[3] ?? "backlog-entries.json";
const lines = readFileSync(path, "utf8").split(/\r?\n/);

const entries = [];
let section = "(preamble)";
let current = null;

const flush = (endLine) => {
  if (!current) return;
  current.end_line = endLine;
  current.text = lines.slice(current.start_line - 1, endLine).join("\n");
  entries.push(current);
  current = null;
};

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const lineNo = i + 1;
  if (line.startsWith("## ")) {
    flush(lineNo - 1);
    section = line.slice(3).trim();
    continue;
  }
  if (line.startsWith("- **")) {
    flush(lineNo - 1);
    const title = line.replace(/^-\s+/, "").replace(/\*\*/g, "").slice(0, 160).trim();
    current = { id: `B${String(entries.length + 1).padStart(3, "0")}`, section, title, start_line: lineNo };
  }
}
flush(lines.length);

writeFileSync(out, JSON.stringify(entries, null, 2));
const bySection = new Map();
for (const e of entries) bySection.set(e.section, (bySection.get(e.section) ?? 0) + 1);
for (const [s, n] of bySection) process.stdout.write(`${n}\t${s}\n`);
process.stdout.write(`${entries.length}\tTOTAL\n`);
