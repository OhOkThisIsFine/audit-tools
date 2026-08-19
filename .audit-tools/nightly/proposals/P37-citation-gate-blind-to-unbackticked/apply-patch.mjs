#!/usr/bin/env node
// P37 patch — backtick the code citations in docs/glossary-ids.md so the existing
// check:doc-code-citations gate can see them. Idempotent; run from the repo root.
import { readFileSync, writeFileSync } from "node:fs";

const TARGET = "docs/glossary-ids.md";
// A citation is a repo-relative path token inside a table row's owner column.
const TOKEN = /(?<!`)((?:src|tests|scripts|spec|schemas|skills)\/[A-Za-z0-9_.\/-]+\.[A-Za-z]{2,4})(?!`)/g;

const before = readFileSync(TARGET, "utf8");
const after = before
  .split("\n")
  .map((line) => (line.startsWith("| ") ? line.replace(TOKEN, "`$1`") : line))
  .join("\n");

writeFileSync(TARGET, after);
const n = (after.match(/`(?:src|tests|scripts|spec|schemas|skills)\//g) || []).length;
console.log(`P37: ${TARGET} — ${n} citations now backticked`);
