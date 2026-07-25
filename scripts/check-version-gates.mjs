#!/usr/bin/env node
//
// Version-gate scan: a schema version that is WRITTEN into persisted state must
// be COMPARED when that state is read back.
//
// State written by an older release is read under the current release's
// semantics. A module that stamps `schema_version` on write and then casts the
// parsed file straight to its payload type is not versioned — it is an
// unchecked cast wearing a version field, and the version field makes it LOOK
// guarded in review. That defect shipped twice in the same shape
// (`readTestPlanCarry`, `readReviewSnapshot`), so it is enforced here instead
// of relied on as authoring discipline.
//
// ── The rule (deliberately narrow, so a RED is always real) ────────────────────
// A constant C is reported ONLY when all three hold:
//   1. some type T declares a version-key member as `typeof C` — T IS the
//      persisted payload shape, and C is the version it is stamped with;
//   2. the codebase reads that payload BACK as T (`readJsonFile<T>`,
//      `readOptionalJsonFile<T>`, `JSON.parse(...) as T`, …) — so old bytes
//      really do re-enter this process under the current semantics;
//   3. neither C nor its literal value ever appears in a check position
//      (`===`/`!==`, `.has()`/`.includes()`, a `Set`/array literal, `z.literal`,
//      `case`, or an argument to an assert/validate/check-style call) ANYWHERE
//      in src.
//
// Condition 2 is what keeps this gate-able. Scanning writes instead would flag
// every envelope emitted for a host to consume and never read back — a false
// RED, which in this repo is as corrosive as a false green. Condition 3 matches
// the constant's VALUE as well as its identifier, so a check written against a
// duplicated string literal (`KNOWN_SCHEMA_VERSIONS` in `intakeResolver.ts`)
// counts as a check.
//
// The cost of that narrowness is false NEGATIVES: a payload read as `unknown`
// and then narrowed by hand, or a version stamped without a `typeof C` member,
// is invisible here. Missing a defect is recoverable; refusing a correct commit
// trains people to bypass the gate.
//
// ── Fixing a RED ──────────────────────────────────────────────────────────────
// Compare the version at the read, using the shared pair in
// `src/shared/io/schemaVersion.ts`, which names the two directions:
//   • regenerable state (cache/carry/snapshot/derived index)
//       → `discardOnSchemaVersionMismatch` — treat as absent and rebuild
//   • costly/authored state (confirmation/checkpoint/authored artifact)
//       → `throwOnSchemaVersionMismatch` — refuse rather than silently lose work
//
// Usage: node scripts/check-version-gates.mjs [--json]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ── Source collection ─────────────────────────────────────────────────────────

export function collectSources(root = process.cwd()) {
  // win32: suppress the console-window flash on every gate run — INV-WH.
  const listed = execFileSync("git", ["ls-files", "src"], {
    encoding: "utf8",
    windowsHide: true,
    cwd: root,
  });
  const sources = new Map();
  for (const rel of listed.split(/\r?\n/)) {
    const path = rel.trim();
    if (!path.endsWith(".ts")) continue;
    sources.set(path, readFileSync(`${root}/${path}`, "utf8"));
  }
  return sources;
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

// ── 1. Version constants ──────────────────────────────────────────────────────

const VERSION_CONST_NAME = /^[A-Z][A-Z0-9_]*_VERSIONS?$/;
// The initializer may sit on the next line (prettier wraps long version strings).
const DECL_RE =
  /(?:^|\n)[ \t]*(export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(?:\r?\n\s*)?("[^"]*"|'[^']*')?/g;

export function findVersionConstants(sources) {
  const decls = [];
  for (const [file, src] of sources) {
    DECL_RE.lastIndex = 0;
    let m;
    while ((m = DECL_RE.exec(src)) !== null) {
      if (!VERSION_CONST_NAME.test(m[2])) continue;
      decls.push({
        name: m[2],
        file,
        line: lineOf(src, m.index) + 1,
        value: m[3] ? m[3].slice(1, -1) : undefined,
        exported: Boolean(m[1]),
      });
    }
  }
  return decls;
}

// ── 2. Persisted payload types (`schema_version: typeof C`) ───────────────────

const VERSION_KEY =
  /^(schema_version|contract_version|schemaVersion|contractVersion|[a-z0-9_]*_schema_version)$/;
const TYPE_BLOCK_RE = /(?:^|\n)(?:export\s+)?(?:interface|type)\s+([A-Za-z0-9_]+)[^{\n]*\{([\s\S]*?)\n\}/g;
const TYPEOF_MEMBER_RE = /([A-Za-z0-9_]+)\??\s*:\s*typeof\s+([A-Z][A-Z0-9_]*)/g;

export function findPayloadTypes(sources) {
  const payloads = [];
  for (const [file, src] of sources) {
    TYPE_BLOCK_RE.lastIndex = 0;
    let block;
    while ((block = TYPE_BLOCK_RE.exec(src)) !== null) {
      const [, typeName, body] = block;
      TYPEOF_MEMBER_RE.lastIndex = 0;
      let member;
      while ((member = TYPEOF_MEMBER_RE.exec(body)) !== null) {
        if (!VERSION_KEY.test(member[1])) continue;
        payloads.push({
          typeName,
          constName: member[2],
          versionKey: member[1],
          file,
          line: lineOf(src, block.index) + 1,
        });
      }
    }
  }
  return payloads;
}

/**
 * Resolve a `typeof C` reference to its declaration: a same-file constant wins
 * (module scope), otherwise the unique EXPORTED constant of that name. Two
 * modules legitimately declare a private `SNAPSHOT_SCHEMA_VERSION`, so a
 * name-keyed lookup would silently conflate them and hide one of the two.
 */
export function resolveConstant(decls, constName, fromFile) {
  const sameFile = decls.find((d) => d.name === constName && d.file === fromFile);
  if (sameFile) return sameFile;
  const exported = decls.filter((d) => d.name === constName && d.exported);
  return exported.length === 1 ? exported[0] : undefined;
}

/**
 * A type name shared by two declarations can't be traced by name — skip it.
 *
 * The trailing `=`/`{`/`extends` is load-bearing: `import { type Foo }` also
 * reads as "type Foo", so a laxer pattern counts every importer as a second
 * declaration and silently drops the payload from the scan entirely.
 */
export function typeNameIsUnique(sources, typeName) {
  const re = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:declare\\s+)?(?:interface|type)\\s+${typeName}\\s*(?:<[^=]*?>)?\\s*(?:=|\\{|extends\\b)`,
    "gm",
  );
  let count = 0;
  for (const src of sources.values()) {
    re.lastIndex = 0;
    while (re.exec(src) !== null) count++;
  }
  return count === 1;
}

// ── 3. Read-back sites ────────────────────────────────────────────────────────

export function findReadBackSites(sources, typeName) {
  const re = new RegExp(
    `\\b(read(?:Optional)?(?:Json|Ndjson)File)\\s*<\\s*${typeName}\\s*>` +
      `|JSON\\.parse\\([^;]*?\\)\\s*as\\s+${typeName}\\b`,
    "g",
  );
  const sites = [];
  for (const [file, src] of sources) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      sites.push({ file, line: lineOf(src, m.index), how: m[1] ?? "JSON.parse as" });
    }
  }
  return sites;
}

// ── 4. Check sites ────────────────────────────────────────────────────────────

const CHECK_CALLEE =
  /(assert|check|validate|require|ensure|expect|is|matches|discard|guard|reject|gate)[A-Za-z0-9_]*$/i;

/**
 * The callee of the call whose ARGUMENT LIST directly encloses `index`, or
 * undefined when the position is not a call argument. A backward paren-balanced
 * walk, because the interesting call is routinely multi-line with parenthesised
 * earlier arguments (`discardOnSchemaVersionMismatch(await readOptionalJsonFile<T>(p), C)`)
 * — a regex that forbids intervening parens misses exactly the shape the fix
 * produces, which would keep REDding a file that is now correct.
 */
export function enclosingCallee(src, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === ")" || ch === "]" || ch === "}") {
      depth++;
    } else if (ch === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      let end = i;
      while (end > 0 && /\s/.test(src[end - 1])) end--;
      let start = end;
      while (start > 0 && /[A-Za-z0-9_$]/.test(src[start - 1])) start--;
      return start < end ? src.slice(start, end) : undefined;
    } else if (ch === "[" || ch === "{") {
      if (depth === 0) return undefined; // an array/object/block, not a call
      depth--;
    } else if (ch === ";" && depth === 0) {
      return undefined; // previous statement — not inside a call
    }
  }
  return undefined;
}

export function classifyCheckPosition(before, after, src, index) {
  if (/(===|!==|==|!=)\s*$/.test(before) || /^\s*(===|!==|==|!=)/.test(after)) {
    return "comparison";
  }
  if (/\.(includes|has|indexOf)\(\s*$/.test(before)) return "membership";
  if (/(literal|enum)\(\s*$/.test(before)) return "schema literal";
  if (/(?:case|switch\s*\()\s*$/.test(before)) return "switch";
  if (/(?:new\s+Set\(\[|\[)[^\]]*$/.test(before)) return "known-versions literal";
  const callee = src === undefined ? undefined : enclosingCallee(src, index);
  if (callee && CHECK_CALLEE.test(callee)) return `argument to ${callee}()`;
  return undefined;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function findCheckSites(sources, decl) {
  const tokens = [
    { re: new RegExp(`\\b${decl.name}\\b`, "g"), byValue: false },
    ...(decl.value
      ? [{ re: new RegExp(`["']${escapeRe(decl.value)}["']`, "g"), byValue: true }]
      : []),
  ];
  const sites = [];
  for (const [file, src] of sources) {
    // A private constant is only ever readable in its own module; a check
    // elsewhere would be against a same-named constant, not this one.
    for (const token of tokens) {
      if (!decl.exported && !token.byValue && file !== decl.file) continue;
      token.re.lastIndex = 0;
      let m;
      while ((m = token.re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, m.index - 200), m.index);
        const after = src.slice(m.index + m[0].length, m.index + m[0].length + 30);
        if (/typeof\s+$/.test(before)) continue; // type position, not a check
        if (/([A-Za-z0-9_]+)\s*:\s*$/.test(before)) continue; // a write, not a check
        const how = classifyCheckPosition(before, after, src, m.index);
        if (how) {
          sites.push({
            file,
            line: lineOf(src, m.index),
            how: token.byValue ? `${how} (by literal value)` : how,
          });
        }
      }
    }
  }
  return sites;
}

// ── The scan ──────────────────────────────────────────────────────────────────

export function scanVersionGates(sources) {
  const decls = findVersionConstants(sources);
  const violations = [];
  const gated = [];
  const seen = new Set();
  for (const payload of findPayloadTypes(sources)) {
    const decl = resolveConstant(decls, payload.constName, payload.file);
    if (!decl) continue; // ambiguous constant — cannot attribute, so never RED
    const key = `${decl.file}::${decl.name}::${payload.typeName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!typeNameIsUnique(sources, payload.typeName)) continue;
    const reads = findReadBackSites(sources, payload.typeName);
    if (reads.length === 0) continue; // never read back — nothing to reinterpret
    const checks = findCheckSites(sources, decl);
    const record = { ...payload, decl, reads, checks };
    if (checks.length > 0) gated.push(record);
    else violations.push(record);
  }
  const order = (a, b) =>
    a.decl.file.localeCompare(b.decl.file) || a.decl.name.localeCompare(b.decl.name);
  return { violations: violations.sort(order), gated: gated.sort(order) };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main() {
  const sources = collectSources();
  const { violations, gated } = scanVersionGates(sources);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ violations, gated }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length > 0) {
    console.error(
      "Schema version stamped on write but never compared on read " +
        `(${violations.length} payload${violations.length === 1 ? "" : "s"}):`,
    );
    for (const v of violations) {
      console.error(`\n  ${v.decl.name}  (${v.decl.file}:${v.decl.line})`);
      console.error(`    stamped into  ${v.typeName}.${v.versionKey}  (${v.file}:${v.line})`);
      for (const r of v.reads) {
        console.error(`    read back at  ${r.file}:${r.line}  via ${r.how} — unchecked`);
      }
    }
    console.error(
      "\nCompare the version at the read, with the pair in src/shared/io/schemaVersion.ts:\n" +
        "  regenerable state (cache/carry/snapshot) -> discardOnSchemaVersionMismatch (treat as absent, rebuild)\n" +
        "  costly/authored state (confirmation/checkpoint) -> throwOnSchemaVersionMismatch (refuse, never silently lose work)",
    );
    return 1;
  }

  console.log(
    `check-version-gates: ${gated.length} persisted payload${gated.length === 1 ? "" : "s"} ` +
      `read back under a version check, 0 unchecked`,
  );
  return 0;
}

// win32: a hand-built `file://` + argv[1] string does not match import.meta.url
// (drive letters get one slash instead of three), so the module would silently
// never run as a CLI. pathToFileURL is the platform-agnostic comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
