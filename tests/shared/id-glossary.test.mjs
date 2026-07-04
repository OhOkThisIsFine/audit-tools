/**
 * id-glossary.test.mjs
 *
 * Guard for ARC-d81a55ab: opaque invariant/node/seam/finding identifier families
 * (`INV-RS-01`, `CE-003`, `N-R13`, `SEAM-rolling-stranding`, `FND-OBS-99e3a861`, …)
 * are load-bearing in source comments and obligation ids but were defined in no
 * glossary, so a reader could not resolve any of them.
 *
 * `docs/glossary-ids.md` is now the canonical lookup table. This test scans every
 * `*.ts` under the three packages' `src/` trees, collects each id-family *prefix*
 * it finds, and asserts the glossary defines that family. A new family coined in
 * code (e.g. `INV-FOO-*`, a new `SEAM-*`) fails here until it is documented.
 *
 * Scoped to families, not individual ids: per-id node/finding identifiers
 * (`N-R13`, `OBS-1234abcd`) are coined freely and consumed once — the finding's
 * recommendation is one row per family, with load-bearing ids enumerated under it.
 */
import { test, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const GLOSSARY = join(REPO_ROOT, "docs", "glossary-ids.md");

const SRC_DIRS = [
  join(REPO_ROOT, "src", "shared"),
  join(REPO_ROOT, "src", "audit"),
  join(REPO_ROOT, "src", "remediate"),
];

/** Recursively collect every `*.ts` file under `dir`. */
function collectTsFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Map a raw identifier token to its glossary *family key*:
 *   INV-RS-01            -> INV-RS   (invariant area)
 *   INV-S05              -> INV-S    (historical alias, documented)
 *   CE-003               -> CE
 *   N-R13 / N-CE301      -> N
 *   SEAM-rolling-...     -> SEAM
 *   OBS-1234abcd         -> OBS      (auditor finding lens prefix)
 *   FND-OBS-...          -> FND
 */
function familyKey(token) {
  if (token.startsWith("INV-")) {
    // Two-letter+ area invariant: INV-<AREA>-<NN>  →  INV-<AREA> (INV-RS-01 → INV-RS).
    const area = /^INV-([A-Za-z]{2,})-\d+$/.exec(token);
    if (area) return `INV-${area[1]}`;
    // Redesign single-letter module: the <letter><digits> node id IS the family, so
    // O1/O2/o3/S03/S04/S05/X06 stay DISTINCT (INV-O1-1 → INV-O1, INV-o3-3 → INV-o3,
    // INV-S05 → INV-S05). Case-preserving so lowercase `INV-o3` resolves.
    const node = /^INV-([A-Za-z]\d+)(?:-\d+)?$/.exec(token);
    if (node) return `INV-${node[1]}`;
    // Fallback: leading letters.
    const m = /^INV-([A-Za-z]+)/.exec(token);
    return `INV-${m[1]}`;
  }
  if (token.startsWith("FND-")) return "FND";
  if (token.startsWith("SEAM-")) return "SEAM";
  if (token.startsWith("CE-")) return "CE";
  if (token.startsWith("N-")) return "N";
  // lens-prefixed finding id (ARC-/COR-/MNT-/TST-/OBS-/REL-/CFG-/DAT-)
  const m = /^([A-Z]{3})-/.exec(token);
  return m ? m[1] : token;
}

// Token shapes we treat as opaque ids worth a glossary entry. Deliberately
// excludes prose words: requires the digit/hash tail.
const TOKEN_RE = new RegExp(
  [
    "\\bINV-[A-Za-z]{2,}-\\d+\\b", // INV-RS-01 (two-letter+ area invariant)
    "\\bINV-[A-Za-z]\\d+(?:-\\d+)?\\b", // INV-O1-1, INV-o3-3, INV-S05, INV-X06 (single-letter redesign module; case-preserving)
    "\\bCE-\\d{3}\\b", // CE-003
    "\\bSEAM-[A-Za-z][A-Za-z-]*\\b", // SEAM-rolling-stranding
    "\\bN-[A-Z]+\\d+\\b", // N-R13, N-CE301
    "\\bFND-[A-Z]{3}-[0-9a-f]{6,8}\\b", // FND-OBS-99e3a861
    "\\b(?:ARC|COR|MNT|TST|OBS|REL|CFG|DAT)-[0-9a-f]{6,8}(?:-\\d)?\\b", // OBS-d81a55ab
  ].join("|"),
  "g",
);

const ALL_SRC = SRC_DIRS.flatMap(collectTsFiles);

/** family -> Set of files that reference it (for diagnostics). */
function collectFamilies() {
  const families = new Map();
  for (const file of ALL_SRC) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(TOKEN_RE)) {
      const fam = familyKey(match[0]);
      if (!families.has(fam)) families.set(fam, new Set());
      families.get(fam).add(file.replace(/\\/g, "/"));
    }
  }
  return families;
}

test("id-glossary: docs/glossary-ids.md exists", () => {
  expect(existsSync(GLOSSARY), "docs/glossary-ids.md must exist as the canonical id-family glossary").toBeTruthy();
});

test("id-glossary: every id-family prefix referenced in src is defined in the glossary", () => {
  const glossary = readFileSync(GLOSSARY, "utf8");
  const families = collectFamilies();

  // A family is "documented" if its key appears verbatim in the glossary text.
  // Lens-prefixed finding ids (ARC/COR/MNT/TST/OBS/REL/CFG/DAT) are all the same
  // "auditor finding id" family — the glossary documents that family via the
  // representative `OBS-` row and the `<LENS>-<hash>` table row, so any lens
  // prefix is satisfied by the presence of the shared explanation.
  const LENS_FINDING_FAMILY = new Set([
    "ARC",
    "COR",
    "MNT",
    "TST",
    "OBS",
    "REL",
    "CFG",
    "DAT",
  ]);
  const lensFamilyDocumented = /`<LENS>-<hash>`/.test(glossary);

  const missing = [];
  for (const [fam, files] of families) {
    if (LENS_FINDING_FAMILY.has(fam)) {
      if (!lensFamilyDocumented) {
        missing.push(`${fam} (auditor-finding family) — first seen in ${[...files][0]}`);
      }
      continue;
    }
    // Every other family key (two-letter areas AND the per-id single-letter
    // redesign modules INV-O1/INV-O2/INV-o3/INV-S03/INV-S04/INV-S05/INV-X06)
    // appears verbatim in the glossary — a plain substring check suffices.
    if (!glossary.includes(fam)) {
      missing.push(`${fam} — referenced in ${[...files].slice(0, 3).join(", ")}`);
    }
  }

  expect(missing, `Every opaque id family referenced in packages/*/src must be defined in docs/glossary-ids.md. ` +
      `Undefined families:\n  ${missing.join("\n  ")}`).toEqual([]);
});

test("id-glossary: the documented INV areas actually occur in the source tree", () => {
  // Anti-rot guard: a documented area that no source file references is dead
  // glossary weight. This keeps the glossary tracking reality, not the reverse.
  const glossary = readFileSync(GLOSSARY, "utf8");
  const families = collectFamilies();
  const liveInvAreas = new Set(
    [...families.keys()].filter((f) => f.startsWith("INV-")),
  );

  // Every `INV-XX` token in the glossary table column must be a live area.
  const documentedInv = new Set(
    [...glossary.matchAll(/`INV-([A-Z]+)`/g)].map((m) => `INV-${m[1]}`),
  );

  const stale = [...documentedInv].filter((a) => !liveInvAreas.has(a));
  expect(stale, `Glossary documents INV areas no longer referenced in src (remove them): ${stale.join(", ")}`).toEqual([]);
});
