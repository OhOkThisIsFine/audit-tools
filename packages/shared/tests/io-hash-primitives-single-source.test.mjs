/**
 * io-hash-primitives-single-source.test.mjs
 *
 * Single-source guards for the IO + hash primitives consolidated into
 * @audit-tools/shared (module: io-and-hash-primitives):
 *
 *   1. The atomic JSON writer lives ONLY in shared/src/io/json.ts. No other
 *      `src/` module across the three packages may reimplement a temp-then-rename
 *      atomic writer (the prior store.ts inline writer + runLedger.ts double
 *      rename are gone — both delegate to shared `writeJsonFile`).
 *   2. `hashContent` is the ONLY SHA-256 content-hash helper. The call sites this
 *      module owns must route through it and carry no inline `createHash("sha256")`
 *      chain or ad-hoc `.slice(0, N)` on a hash result.
 *   3. `AccessDeclaration` is declared ONCE, in shared. The orchestrators import
 *      the shared type; neither redeclares it locally.
 *
 * These are source-level guards: they read files and assert on their text so a
 * regression (a reintroduced inline writer / a second hash helper / a local
 * AccessDeclaration) fails here rather than silently drifting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES = resolve(__dirname, "../..");

const SHARED_SRC = join(REPO_PACKAGES, "shared", "src");
const AUDIT_SRC = join(REPO_PACKAGES, "audit-code", "src");
const REMEDIATE_SRC = join(REPO_PACKAGES, "remediate-code", "src");

const SHARED_JSON_WRITER = join(SHARED_SRC, "io", "json.ts");
const SHARED_HASH = join(SHARED_SRC, "hash.ts");
const SHARED_ACCESS_DECLARATION = join(SHARED_SRC, "types", "accessDeclaration.ts");

function read(path) {
  return readFileSync(path, "utf8");
}

/** Recursively collect every `*.ts` file under `dir`. */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const ALL_SRC_FILES = [
  ...collectTsFiles(SHARED_SRC),
  ...collectTsFiles(AUDIT_SRC),
  ...collectTsFiles(REMEDIATE_SRC),
];

// ── Guard 1: single atomic JSON writer ────────────────────────────────────────

test("io-hash-single-source/1a: shared writeJsonFile exists and is the atomic writer", () => {
  const src = read(SHARED_JSON_WRITER);
  assert.match(
    src,
    /function writeFileAtomic\(/,
    "shared/src/io/json.ts must define the atomic writer writeFileAtomic",
  );
  assert.match(
    src,
    /export async function writeJsonFile\(/,
    "shared/src/io/json.ts must export writeJsonFile",
  );
});

test("io-hash-single-source/1b: no other src module defines a temp-then-rename atomic writer", () => {
  const offenders = [];
  for (const file of ALL_SRC_FILES) {
    if (file === SHARED_JSON_WRITER) continue;
    const src = read(file);
    // The atomic-write tell is a `.tmp` temp file paired with a rename(). Move/
    // archive renames (rename(path, `${path}.consumed-...`)) have no `.tmp`
    // temp literal, so they do not trip this. A reintroduced inline writer would.
    const declaresOwnWriteFileAtomic = /function\s+writeFileAtomic\b/.test(src);
    const writesTempThenRenames =
      /\.tmp(`|")/.test(src) && /\brename\s*\(/.test(src);
    if (declaresOwnWriteFileAtomic || writesTempThenRenames) {
      offenders.push(file.replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Only shared/src/io/json.ts may implement an atomic JSON writer; offenders route their durable write through shared writeJsonFile instead: ${offenders.join(", ")}`,
  );
});

// ── Guard 2: single SHA-256 content-hash helper ───────────────────────────────

// The call sites this module consolidated onto shared `hashContent`. Each must
// import hashContent from @audit-tools/shared and carry no inline createHash.
const HASH_CONTENT_CONSUMERS = [
  join(AUDIT_SRC, "extractors", "fsIntake.ts"),
  join(AUDIT_SRC, "orchestrator", "fileIntegrity.ts"),
  join(AUDIT_SRC, "reporting", "findingIdentity.ts"),
  join(REMEDIATE_SRC, "utils", "fileIntegrity.ts"),
  join(REMEDIATE_SRC, "intake.ts"),
  join(REMEDIATE_SRC, "contractPipeline", "artifactStore.ts"),
];

test("io-hash-single-source/2a: shared hashContent exists and is exported", () => {
  const src = read(SHARED_HASH);
  assert.match(
    src,
    /export function hashContent\(/,
    "shared/src/hash.ts must export the hashContent primitive",
  );
});

test("io-hash-single-source/2b: consolidated call sites route through shared hashContent (no inline sha256)", () => {
  for (const file of HASH_CONTENT_CONSUMERS) {
    const src = read(file);
    const rel = file.replace(/\\/g, "/");
    assert.ok(
      /hashContent/.test(src),
      `${rel} must use the shared hashContent primitive`,
    );
    assert.ok(
      !/createHash\(\s*["']sha256["']\s*\)/.test(src),
      `${rel} must not carry an inline createHash("sha256") chain — route through hashContent`,
    );
  }
});

test("io-hash-single-source/2c: no ad-hoc .slice on a hashContent result at the consolidated sites", () => {
  // Truncation length is passed explicitly via { length }, never a trailing
  // `.slice(0, N)` literal hung off the hash call.
  for (const file of HASH_CONTENT_CONSUMERS) {
    const src = read(file);
    const rel = file.replace(/\\/g, "/");
    assert.ok(
      !/hashContent\([^;]*\)\s*\.slice\(/.test(src),
      `${rel} must pass truncation length via hashContent(..., { length }), not a trailing .slice() on the result`,
    );
  }
});

// ── Guard 3: single AccessDeclaration declaration ─────────────────────────────

test("io-hash-single-source/3a: AccessDeclaration is declared only in shared", () => {
  // A real declaration: `interface AccessDeclaration {` (optionally `extends ...`)
  // or `type AccessDeclaration =`. This deliberately does NOT match an import or
  // re-export specifier like `type AccessDeclaration,` inside `{ ... }`, which is
  // a reference to the shared type, not a redeclaration.
  const declRegex =
    /(?:export\s+)?(?:interface\s+AccessDeclaration\b[^=]*\{|type\s+AccessDeclaration\s*=)/;
  // Shared owns the single declaration.
  assert.match(
    read(SHARED_ACCESS_DECLARATION),
    declRegex,
    "shared/src/types/accessDeclaration.ts must declare the AccessDeclaration type",
  );
  // No other src file may declare it (re-export / import of the shared type is
  // fine and is excluded below: a re-export is `export type { AccessDeclaration }`
  // which has no `interface|type` keyword).
  const offenders = [];
  for (const file of ALL_SRC_FILES) {
    if (file === SHARED_ACCESS_DECLARATION) continue;
    if (declRegex.test(read(file))) offenders.push(file.replace(/\\/g, "/"));
  }
  assert.deepEqual(
    offenders,
    [],
    `AccessDeclaration must be declared only in shared; redeclared in: ${offenders.join(", ")}`,
  );
});

test("io-hash-single-source/3b: orchestrators import AccessDeclaration from shared, not a local copy", () => {
  const remediateTypes = read(join(REMEDIATE_SRC, "steps", "types.ts"));
  const auditWorkerSession = read(join(AUDIT_SRC, "types", "workerSession.ts"));

  for (const [label, src] of [
    ["remediate-code/src/steps/types.ts", remediateTypes],
    ["audit-code/src/types/workerSession.ts", auditWorkerSession],
  ]) {
    assert.ok(
      /AccessDeclaration[^]*from\s+["']@audit-tools\/shared["']/.test(src),
      `${label} must import AccessDeclaration from @audit-tools/shared`,
    );
  }

  // The earlier duplicate was a second `AccessDeclaration` listed in a separate
  // `export type { ... } from "@audit-tools/shared"` block. Guard against the
  // name being pulled from shared in more than one statement in steps/types.ts.
  const sharedAccessImports = (
    remediateTypes.match(/AccessDeclaration/g) ?? []
  ).filter(Boolean);
  // Two legitimate uses remain: the re-export binding and the field type
  // annotations. The duplicate cross-package listing pushed this to four refs
  // across two `from "@audit-tools/shared"` statements; collapsing to one import
  // keeps it at exactly one import statement carrying the name.
  const importStatementsWithAccess = (
    remediateTypes.match(
      /import\s+type\s+\{[^}]*AccessDeclaration[^}]*\}\s+from\s+["']@audit-tools\/shared["']/g,
    ) ?? []
  ).length;
  assert.equal(
    importStatementsWithAccess,
    1,
    "remediate-code/src/steps/types.ts must import AccessDeclaration in exactly one statement (no duplicate cross-package listing)",
  );
  assert.ok(sharedAccessImports.length >= 1);
});
