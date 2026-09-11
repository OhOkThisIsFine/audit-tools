#!/usr/bin/env node
//
// Per-type CONSTRUCTION-SITE reconciliation — the second half of the pinning
// story, and the per-type contract coverage that used to be derived from where
// TESTS live (`docs/backlog/minor-bugs.md`, 2026-07-25).
//
// P27 shipped `check:sites-pinned` (the per-site pinning gate, whose site list is
// DERIVED from the staged diff). This is the other gate, and it answers a
// different question with a different derivation:
//
//   check:sites-pinned    — for each site this CHANGE touched, is it pinned?
//   check:contract-sites  — for each validated CONTRACT TYPE, is every producer
//                           site derived FROM THE CONTRACT, so a producer cannot
//                           miss a field the contract added?
//
// Two contract types are walked, and each walk is the doc-manifest shape (data +
// refusal, `2adc716c`) rather than a typecheck — a cast makes a typecheck inert,
// which is exactly how a producer keeps missing a field:
//
//   1. RENDERED SCHEMAS. `CONTRACT_SCHEMA_PRODUCERS`
//      (`src/audit/contracts/workerSchemas.ts`) pairs each `schemas/*.schema.json`
//      this repo renders with the canonical contract it is rendered from. The
//      rendered property set must EQUAL the contract's declared field set, in
//      both directions, or a worker-facing schema has stopped describing the
//      contract it advertises. The derivation starts from the CONTRACT — read as
//      data out of `CONTRACT_PROPERTY_SHAPES` — never from which files mention
//      the schema.
//
//   2. PRODUCER CONSTRUCTION SITES. Every contract type in the registry must be
//      constructed somewhere a PRODUCER lives (`scripts/`, `src/**` outside the
//      test tree, the package entries, the wrapper/dispatch trees) — not only in
//      the tests, which is the arrangement that let a `scripts/` producer sweep
//      past. A site is marked `// construction-site: <Type>` and an absence is
//      marked `// contract-construction-sites: exempt — <why>`; a type with
//      NEITHER is the refusal.
//
//       The exemption is what keeps the requirement honest: a producer whose
//       shape deliberately differs can say so, in one line, at the site — and
//       the reader sees the decision instead of an absence.
//
// WHAT THIS DOES NOT PROVE, stated because a partly-enforced trap is not
// deletable: a site marker says a producer CONSTRUCTS this contract here — it
// does not prove the construction passes every field (a spread of a partial
// still compiles), and it does not prove the site is REACHED at runtime. The
// half this closes is the DENOMINATOR: the set of sites is derived from the
// contract, so a producer can no longer be missing from the list because nobody
// remembered it.
//
//   node scripts/check-contract-sites.mjs        # verify
//
// The reconciliation is exported as a library (driven with fixture trees by
// tests/shared/contract-construction-sites.test.ts); the CLI body runs only on
// direct invocation.
//
// sites-pinned: tests/shared/contract-construction-sites.test.ts
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The repo-wide argument rule. This gate takes no arguments at all, so an
// unrecognized one must be refused rather than ignored — the argv-guard shape.
import { guardArgv } from './shared/argvGuard.mjs';
import { CONTRACT_SCHEMA_PRODUCERS } from '../src/audit/contracts/workerSchemas.ts';
import { CONTRACT_PROPERTY_SHAPES } from '../src/shared/types/contractPropertyShapes.ts';
import {
  deriveConstructionSites,
  isProducerPath,
  parseSiteMarkers,
  reconcileRenderedSchema,
} from '../src/shared/validation/contractConstructionSites.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The verdict fields a construction-site marker may NEVER name, whatever the
 * contract declares — the fields a HOST supplies and the tool refuses.
 *
 * `WorkerFindingSchema` omits them from the worker projection on purpose, so a
 * marker naming one is describing the wrong contract: either the site consumes a
 * host-supplied verdict rather than constructing one, or the marker was copied
 * from somewhere that does. Naming them here rather than letting the generic
 * "the contract does not declare it" message answer is the difference between a
 * refusal a reader can act on and one they have to decode.
 */
export const FORBIDDEN_MARKER_FIELDS = [
  'evidence_lane',
  'verification_status',
  'grounding',
  'severity_downgraded_from',
  'lead_lineage',
];

/** The declared field set of a contract type, out of the registry (data, not zod). */
export function contractFieldSet(typeShape) {
  const properties = Object.keys(typeShape.properties ?? {});
  const required = properties.filter((p) => !typeShape.properties[p]?.allowsUndefined);
  return { properties: new Set(properties), required: new Set(required) };
}

/**
 * A rendered schema is not a transcript of its contract — a worker projection
 * OMITS tool-owned fields and ADDS its own. Each difference is DECLARED on the
 * pairing, never guessed, so the expected property set is computed from the
 * contract plus its declarations:
 *
 *   expected = (contract properties − pairing.omitted) ∪ pairing.added
 *
 * Deriving it here rather than relaxing the comparison is the point: an
 * UNDECLARED difference still reds, while a declared one stops being reported as
 * drift on every run. A gate that cries wolf on its own settled design is a gate
 * that gets ignored.
 *
 * REQUIRED-NESS IS DELIBERATELY NOT COMPARED. The worker projection is a
 * different contract from the base one, and it relaxes or strengthens
 * required-ness on purpose: `WorkerFindingSchema` makes `lens` optional
 * (defaulted from the enclosing result) where the shared Finding requires it, and
 * strengthens `evidence` where the shared Finding leaves it optional. Comparing
 * that against the base contract would report a design decision as drift on
 * every run. The property SET is the thing a producer misses when the contract
 * grows, and that is what is compared.
 */
export function expectedSchemaFieldSet(contract, pairing) {
  const omitted = new Set(pairing.omitted ?? []);
  const added = new Set(pairing.added ?? []);
  const properties = new Set([...contract.properties].filter((p) => !omitted.has(p)));
  for (const p of added) properties.add(p);
  // `required` is carried through UNCHANGED and never compared — see the note
  // above; the shape is the shared `ContractFieldSet` because that is what
  // `reconcileRenderedSchema` takes.
  return { properties, required: contract.required };
}

/**
 * Reconcile the registry + the producer declarations against a supplied tree.
 * Pure — every read is injected, so the contract test drives fixture trees and
 * every refusal path gets exercised without breaking the real repo.
 *
 * @param {{
 *   tracked: readonly string[],
 *   readText: (path: string) => string,
 *   contractTypes?: readonly any[],
 *   schemaProducers?: Record<string, {contract: string, message: string, added?: readonly string[], omitted?: readonly string[], requiredOverride?: readonly string[]}>,
 *   schemaFiles?: (path: string) => boolean,
 * }} input
 * @returns {string[]} error strings (empty = clean)
 */
export function reconcileContractSites({
  tracked,
  readText,
  contractTypes = CONTRACT_PROPERTY_SHAPES,
  schemaProducers = CONTRACT_SCHEMA_PRODUCERS,
  schemaFiles = (p) => /^schemas\/.*\.schema\.json$/.test(p),
}) {
  const errors = [];
  const byType = new Map(contractTypes.map((c) => [c.type, c]));
  const bySchema = new Map(contractTypes.map((c) => [c.schema, c]));

  // The DECLARED MARKERS, derived once and reused by both halves below: the
  // denominator refusal (a type nothing declares) and the field-set check (a
  // marker naming a field the contract does not have). Deriving it here rather
  // than inside the loop keeps ONE walk over the tree.
  const derived = deriveConstructionSites(
    tracked.map((file) => {
      if (!isProducerPath(file)) return { file, markers: [] };
      try {
        return { file, markers: parseSiteMarkers(readText(file)) };
      } catch {
        return { file, markers: [] };
      }
    }),
    contractTypes.map((c) => c.type),
  );

  // ── 1. rendered schemas: the property set must equal the contract's ─────────
  for (const [schemaFile, producer] of Object.entries(schemaProducers)) {
    if (!tracked.includes(schemaFile)) {
      errors.push(
        `${schemaFile} is declared in CONTRACT_SCHEMA_PRODUCERS but is not a tracked file — the ` +
          `derivation names a schema nothing renders.`,
      );
      continue;
    }
    const contract = byType.get(producer.contract) ?? bySchema.get(producer.contract);
    if (!contract) {
      errors.push(
        `CONTRACT_SCHEMA_PRODUCERS pairs ${schemaFile} with contract "${producer.contract}", which ` +
          `is in no CONTRACT_PROPERTY_SHAPES row — a producer naming a contract the registry does ` +
          `not hold can never be reconciled.`,
      );
      continue;
    }
    let rendered;
    try {
      rendered = JSON.parse(readText(schemaFile));
    } catch (error) {
      errors.push(`${schemaFile} could not be parsed as JSON: ${/** @type {Error} */ (error).message}`);
      continue;
    }
    errors.push(
      ...reconcileRenderedSchema({
        schemaFile,
        rendered,
        contract: expectedSchemaFieldSet(contractFieldSet(contract), producer),
        message: producer.message,
        // What the type's construction-site markers CLAIM about the contract.
        // Empty when no marker declares fields — no claim, nothing to reconcile.
        markerFields: derived.sites.get(contract.type)?.fields ?? [],
        declaredExceptions: producer.added ?? [],
      }),
    );
  }

  // ── 1b. the reverse: every registry contract that IS a rendered schema ─────
  // A contract whose rendered schema nobody paired is the silent half of the
  // same hole — the schema would keep describing the old field set forever.
  for (const contract of contractTypes) {
    const matching = tracked.filter((f) => schemaFiles(f) && mentionsContract(readText, f, contract.type));
    if (matching.length === 0) continue;
    const paired = matching.some((f) => f in schemaProducers);
    if (!paired) {
      errors.push(
        `contract "${contract.type}" is rendered into ${matching.join(", ")} but no ` +
          `CONTRACT_SCHEMA_PRODUCERS row pairs it with its canonical contract — the rendered ` +
          `property set is then reconciled against nothing.`,
      );
    }
  }

  // ── 2. producer construction sites, derived from the CONTRACT ───────────────
  // `derived` was walked above, before the schema loop, because the schema half
  // reconciles the SAME markers against the contract's field set.
  //
  // Two refusals, one per half of what a declared marker claims. The first is the
  // DENOMINATOR (a type nothing declares); the second holds a marker to the
  // contract's OWN fields, and it runs HERE rather than only inside the schema
  // loop so that every registry type is checked — most types have no rendered
  // schema, and a marker-field claim on one of those was otherwise never read.
  for (const contract of contractTypes) {
    const entry = derived.sites.get(contract.type);
    if (!entry || (entry.sites.length === 0 && entry.exemptions.length === 0)) {
      errors.push(
        `contract type "${contract.type}" (${contract.schema}) has NO construction site in any ` +
          `producer and no declared exemption — a producer cannot be held to a contract no producer ` +
          `constructs. Add \`// construction-site: ${contract.type}\` at each constructing site, or ` +
          `\`// contract-construction-sites: exempt — ${contract.type} <why>\` where the absence is ` +
          `deliberate.`,
      );
      continue;
    }
    errors.push(...reconcileMarkerFields(contract, entry, contractTypes));
  }
  errors.push(...derived.unknown);

  return errors;
}

/**
 * Hold a type's declared marker FIELDS to the contract's own field set.
 *
 * A marker sits AT a construction site and names a field of THAT contract, so a
 * name the contract does not declare means the site has drifted off the type — or
 * that the marker was copied onto a consumer, which is the shape a marker-derived
 * walk cannot otherwise tell apart from a real site. This is the one construction
 * question that IS decidable from source without dataflow: the claim is free text
 * on the marker, and the contract's fields are data in the registry.
 *
 * The comparison goes through the same `reconcileRenderedSchema` the schema half
 * uses, so the two directions of "this name is not a field of this contract"
 * cannot drift apart. The rendered schema is the CONTRACT ITSELF here (`properties`
 * from the row, nothing omitted or added), because there is no projection to
 * reconcile — only the field set both sides already agree on.
 *
 * A declared field that IS one of the type's FORBIDDEN verdict fields is named
 * explicitly rather than left to the generic message: `evidence_lane`,
 * `verification_status`, `grounding`, `severity_downgraded_from` and `lead_lineage`
 * are omitted from the WORKER projection on purpose (a host supplying one is
 * refused), so a marker claiming one is describing the wrong contract.
 */
function reconcileMarkerFields(contract, entry, contractTypes) {
  if (entry.fields.length === 0) return [];
  const owner = contractTypes.find((c) => c.type === contract.type);
  const message =
    `\`${contract.type}\` is the contract whose fields these are; a marker that names a field it ` +
    `does not declare has drifted off the type (see the marker's own \`fields=\` operand).`;
  const errors = reconcileRenderedSchema({
    schemaFile: `${contract.schema} (declared markers)`,
    rendered: { properties: Object.fromEntries(Object.keys(owner.properties).map((k) => [k, true])) },
    contract: contractFieldSet(owner),
    message,
    markerFields: entry.fields,
  });
  // A FORBIDDEN field is refused by the NAMED branch ALONE, even when the
  // contract does not declare it: handing the reader both the generic "the
  // contract does not declare it" text and the specific one says the same thing
  // twice and buries the actionable half. `severity_downgraded_from` and
  // `lead_lineage` are undeclared AND forbidden, so this exclusion is what makes
  // their refusal the named one.
  const forbidden = FORBIDDEN_MARKER_FIELDS.filter((field) => entry.fields.includes(field));
  const generic = errors.filter((error) => !forbidden.some((field) => error.includes(field)));
  return [...generic, ...forbiddenMarkerFieldRefusals(contract, forbidden)];
}

/**
 * The NAMED branch: a marker declaring one of the type's forbidden verdict
 * fields.
 *
 * It runs for every forbidden field the marker names, whether or not the
 * contract declares it — `grounding`, `evidence_lane` and `verification_status`
 * ARE declared by the shared `Finding`, so the generic message never fires for
 * them and the marker would otherwise pass silently while naming a field the
 * construction site cannot be setting. Each refusal names the field the marker
 * wrote, so the reader sees which operand to delete rather than a verdict about
 * their marker as a whole.
 */
function forbiddenMarkerFieldRefusals(contract, forbidden) {
  return forbidden.map(
    (field) =>
      `${contract.schema} (declared markers): a construction-site marker for \`${contract.type}\` ` +
      `declares \`field=${field}\`, which is a FORBIDDEN VERDICT FIELD — \`${field}\` is supplied by ` +
      `the HOST and refused by the tool (it is omitted from the worker projection for exactly that ` +
      `reason), so no producer constructs it and no marker may claim to. Remove \`${field}\` from ` +
      `the marker's \`fields=\` operand; if the site really does assemble this verdict, the site is ` +
      `a consumer and the marker belongs at the producer.`,
  );
}

// Does this file's TEXT name the contract type at all? Used only to decide
// whether a contract has a rendered schema waiting to be paired — a negative
// answer is not a verdict, which is why nothing fails on it.
function mentionsContract(readText, file, type) {
  try {
    return readText(file).includes(type);
  } catch {
    return false;
  }
}

function main() {
  // `git ls-files` — the TRACKED tree, never the filesystem. windowsHide: an
  // unguarded spawn flashes a console window on win32 inside verify:checks
  // (INV-WH).
  const tracked = execFileSync('git', ['ls-files'], {
    encoding: 'utf8',
    cwd: repoRoot,
    windowsHide: true,
  })
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const errors = reconcileContractSites({
    tracked,
    readText: (rel) => readFileSync(join(repoRoot, rel), 'utf8'),
  });

  if (errors.length > 0) {
    console.error('✗ contract-sites check failed:\n\n' + errors.join('\n\n') + '\n');
    process.exit(1);
  }
  console.log(
    `✓ contract-sites: ${Object.keys(CONTRACT_SCHEMA_PRODUCERS).length} rendered schema(s) carry exactly ` +
      `their contract's field set; every one of the ${CONTRACT_PROPERTY_SHAPES.length} contract type(s) ` +
      `has a producer construction site`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // No spec: this gate accepts no arguments, which is the strictest form and
  // the right one for a check that resolves its subject from the repo root.
  guardArgv(process.argv.slice(2), {
    name: 'check-contract-sites',
    usage: 'node scripts/check-contract-sites.mjs',
  });
  main();
}
