/**
 * finding-identity-single-source.test.mjs
 *
 * Single-source guards for the finding-identity authority consolidated into
 * audit-tools/shared (drift-plan R2 + P5):
 *
 *   1. `findingIdentitySignature` (and its `normalizeAnchorPath` /
 *      `normalizeTitle` helpers) is DEFINED only in
 *      shared/src/findingIdentitySignature.ts. Any other `src/` module across the
 *      three packages may import or re-export it (a delegating wrapper is fine),
 *      but must not declare a second implementation of the "is this the same
 *      finding?" rule.
 *   2. `mintUniqueId` (the `-N` collision-suffix loop) is DEFINED only in
 *      shared/src/ids.ts. The audit re-keyer and the remediate contract-pipeline
 *      deriver import it; neither carries its own suffix loop.
 *
 * These are source-level guards: they read files and assert on their text so a
 * regression (a reintroduced second identity rule / a second mint loop) fails
 * here rather than silently drifting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_PACKAGES = resolve(__dirname, "../..");

const SHARED_SRC = join(REPO_PACKAGES, "src", "shared");
const AUDIT_SRC = join(REPO_PACKAGES, "src", "audit");
const REMEDIATE_SRC = join(REPO_PACKAGES, "src", "remediate");

const SHARED_IDENTITY = join(SHARED_SRC, "findingIdentitySignature.ts");
const SHARED_IDS = join(SHARED_SRC, "ids.ts");

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

// A real declaration carries the `function` keyword. A re-export
// (`export { findingIdentitySignature }`) or an import specifier does not, so
// those legitimate references are excluded.
function definesFunction(src, name) {
  return new RegExp(`(?:export\\s+)?function\\s+${name}\\s*\\(`).test(src);
}

// ── Guard 1: single finding-identity-signature authority ──────────────────────

test("finding-identity-single-source/1a: shared findingIdentitySignature.ts defines the authority", () => {
  const src = read(SHARED_IDENTITY);
  assert.ok(
    definesFunction(src, "findingIdentitySignature"),
    "shared/src/findingIdentitySignature.ts must define findingIdentitySignature",
  );
  assert.ok(
    definesFunction(src, "normalizeAnchorPath"),
    "shared/src/findingIdentitySignature.ts must define normalizeAnchorPath",
  );
  assert.ok(
    definesFunction(src, "normalizeTitle"),
    "shared/src/findingIdentitySignature.ts must define normalizeTitle",
  );
});

test("finding-identity-single-source/1b: no other src module reimplements the finding-identity signature", () => {
  // A delegating re-export (audit's reporting/findingIdentity.ts does
  // `export { findingIdentitySignature }`) is allowed; a second `function`
  // definition of the signature or its normalizers is not.
  for (const name of [
    "findingIdentitySignature",
    "normalizeAnchorPath",
    "normalizeTitle",
  ]) {
    const offenders = [];
    for (const file of ALL_SRC_FILES) {
      if (file === SHARED_IDENTITY) continue;
      if (definesFunction(read(file), name)) {
        offenders.push(file.replace(/\\/g, "/"));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `Only shared/src/findingIdentitySignature.ts may define ${name}; a delegating re-export is fine. Offenders: ${offenders.join(", ")}`,
    );
  }
});

// ── Guard 2: single mintUniqueId collision-suffix loop (drift-plan P5) ─────────

test("finding-identity-single-source/2a: shared ids.ts defines mintUniqueId", () => {
  assert.ok(
    definesFunction(read(SHARED_IDS), "mintUniqueId"),
    "shared/src/ids.ts must define mintUniqueId",
  );
});

test("finding-identity-single-source/2b: no other src module reimplements a mint-unique-id collision loop", () => {
  const offenders = [];
  for (const file of ALL_SRC_FILES) {
    if (file === SHARED_IDS) continue;
    const src = read(file);
    // A second mint loop tells on itself either by redefining mintUniqueId or by
    // an inline `while (<set>.has(id))` id-disambiguation loop (the prior
    // remediate `mintId`). Importers reference `mintUniqueId` without either.
    const declaresMint = definesFunction(src, "mintUniqueId") || definesFunction(src, "mintId");
    const inlineCollisionLoop = /while\s*\(\s*[\w.]+\.has\(\s*id\s*\)\s*\)/.test(src);
    if (declaresMint || inlineCollisionLoop) {
      offenders.push(file.replace(/\\/g, "/"));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Only shared/src/ids.ts may implement the unique-id collision loop; route through mintUniqueId. Offenders: ${offenders.join(", ")}`,
  );
});
