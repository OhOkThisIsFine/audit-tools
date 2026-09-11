// Per-type CONSTRUCTION-SITE derivation — for every validated contract type, the
// set of places that construct one is derived from the CONTRACT, not from where
// the tests happen to live.
//
// THE DEFECT CLASS. `AuditResult` gained a field; the change swept the test tree,
// missed the producers under `scripts/`, and failed release CI. `scripts/` was
// covered by no tsconfig at the time (closed since — `check:scripts` typechecks
// it), so nothing there could fail on a contract it never consulted. A per-type
// suite written BY HAND closed that one instance and stated the class as
// "not yet designed".
//
// WHY NOT A TYPECHECK. A cast silences a typecheck, and a cast is precisely how a
// producer keeps missing a field the contract added. The enforcement has to be
// the CONSTRUCTION SITE, not the type annotation.
//
// THE MECHANISM, and it is the doc-manifest shape (data + refusal) rather than a
// new one: a contract type is a ROW (`CONTRACT_PROPERTY_SHAPES`), the sites are
// DERIVED from the contract's own field list — never a hand list — and the walk
// REFUSES when a declared site does not account for a field. `audit-tools/shared`
// owns the walk; the per-area gate that runs it is `scripts/check-contract-sites.mjs`.
//
// WHY NOT EVERY CONSTRUCTION SITE. A test that builds a hand-written literal of
// a contract is BUFFERED by that literal: adding a field does not break it, and
// the buffering is intentional (the test is describing a shape it wants to keep
// stable). A PRODUCER — anything under `scripts/`, `src/**/cli/`, or a package
// entry — has no such buffer: it is the thing that must carry the new field. So
// the walk requires a site in every producer and refuses a MISSING marker; the
// exemption marker exists for the case where a producer's shape really should
// differ, and it has to be written down with a reason rather than left silent.
//
// ⚠ WHAT THIS STILL DOES NOT DERIVE — read before trusting a green run.
//
// The DENOMINATOR is the registry, and the walk refuses a type with no marker at
// all. But the walk does NOT yet find a construction site that carries no marker:
// it counts markers that ARE there, so a producer added tomorrow without one
// leaves the type's count unchanged and the gate green. That is the very shape
// this module exists to close, one level down.
//
// It is not an oversight, and it is not for want of trying — it is stated here
// because a partly-enforced trap has to say which half is open. Deriving the
// construction sites means deciding, from source, whether a value is CONSTRUCTED
// as the contract or merely passes through one; that is a path-sensitive dataflow
// question, and every mechanical approximation of it was measured to be WRONG in
// this tree in BOTH directions:
//
//   • it MISSES real sites — `sampleRunCommand.ts`'s SAMPLE_REPORT_FINDING,
//     `scripts/audit/smoke-audit-flow.mjs`'s synthetic AuditResult, and the
//     finding literals in `designAssessment.ts` all construct a contract and
//     carry no marker;
//   • it FLAGS non-sites — markers already sit on readers and passthroughs
//     (`syntaxResolutionExecutor.ts` reads a tsc match; `partitionTaskGraph.ts`
//     returns a trace built in `contentCoherence.ts`), so "find the construction
//     site" and "find the marked line" are not even the same question today.
//
// A marker-derived detector would therefore report the union of its own
// blindspot and its own false positives as "every site is marked" — a gate that
// reads greener than the property it names. The step is refused rather than
// approximated; the property that IS enforced is the one below.
//
// WHAT THIS DOES PROVE, stated precisely so the refusal above cannot be read as
// "nothing is checked": the set of MARKERS is derived and sorted, so a producer
// cannot be absent from the site list because nobody remembered it, and — the
// half the earlier lane left to an author's self-report — a type that is marked
// but for which NO producer actually carries the field set is now caught. A
// marker left behind after the construction it names was deleted, a marker on a
// consumer, and a producer rewritten to a partial literal all red on the next
// run. Test files and `.claude/` are excluded, so a test that constructs the
// contract cannot stand in for a producer.

//
// sites-pinned: tests/shared/contract-construction-sites.test.ts
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

/** The marker a producer carries at each construction site. */
export const SITE_MARKER = "construction-site";

/** The marker a producer carries where a construction site deliberately does not exist. */
export const SITE_EXEMPTION_MARKER = "contract-construction-sites";

/**
 * A tracked path is a PRODUCER — something that constructs the artifact the
 * contract describes, rather than a test that buffers its own literal.
 *
 * `scripts/` is the tree that started this: a producer there had no tsconfig and
 * no gate. `src/**` is a producer except its own test tree; a package entry
 * (`audit-code.mjs`, `remediate-code.mjs`) and the wrapper/dispatch trees are
 * producers by position. `tests/` and `.claude/` are NOT — a fixture literal is
 * the buffer the contract is meant to survive, and a hook cannot import the
 * package (it runs pre-build).
 */
export function isProducerPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("tests/")) return false;
  if (p.startsWith(".claude/")) return false;
  if (p.startsWith("src/shared/types/contractPropertyShapes")) return false;
  if (p.startsWith("scripts/")) return true;
  if (p.startsWith("src/")) return !p.includes("/__") && !/\.test\.[cm]?tsx?$/.test(p);
  if (p.startsWith("wrapper/") || p.startsWith("dispatch/")) return true;
  return /^[^/]+\.mjs$/.test(p);
}

/** One `// construction-site: <name>` occurrence, and whether it is an exemption. */
export interface SiteMarker {
  /** The contract type the marker names, verbatim. */
  readonly type: string;
  /** Free text after the type, up to the end of the comment. */
  readonly note: string;
  /** `true` for `// contract-construction-sites: exempt — <why>`. */
  readonly exempt: boolean;
  /**
   * The contract FIELD names the marker's note declares, in the `field=` /
   * `fields=a,b` form. Empty when the note names none — the common case, and
   * NOT an error: a marker without fields is a marker whose author declared no
   * field-level claim, which is what every earlier marker did.
   */
  readonly fields: readonly string[];
}

/**
 * The `fields=` / `field=` operand of a marker's note, as a name list.
 *
 * The form is deliberately narrow and literal (`field=`, `fields=`, then a
 * comma-separated list of identifier-shaped names) so that prose in a note — the
 * reason a site exists, what it passes — is never mistaken for a field claim.
 * A note that says "the `findings` array" claims no field; a note that says
 * `fields=path,line_start` claims two. Only the latter is checkable, so only the
 * latter is read.
 */
export function parseMarkerFields(note: string): string[] {
  const m = note.match(/\bfields?=([^\s)]+)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((f) => f.trim())
    .filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f));
}

// `//` only, and only at the START of a line (leading whitespace allowed): this
// walk reads PRODUCER sources, and a producer's block comment is prose about the
// file. A `//` comment is what an author writes AT the site.
//
// ANCHORING IS LOAD-BEARING, not tidiness. Unanchored, this pattern also matches
// the marker text inside a STRING LITERAL or a doc-comment sentence — the gate's
// own refusal messages quote `// construction-site: ${contract.type}`, and the
// walker then reports the gate as declaring sites for the types
// "${contract.type}" and "<name>`". The gate read its own error text as data.
const MARKER_RE = /^[ \t]*\/\/[ \t]*([a-z-]+):[ \t]*([^\n]*)$/gm;

/**
 * Every construction-site marker in a source file, for every contract type.
 *
 * Both markers are matched here and classified by name so a typo (`// construction
 * site:` or `// construction-sites:`) is an UNRECOGNIZED marker rather than a
 * silently ignored line — the refusal that matters most is the one for a site the
 * author believes they declared.
 */
export function parseSiteMarkers(source: string): SiteMarker[] {
  const found: SiteMarker[] = [];
  for (const m of source.matchAll(MARKER_RE)) {
    const name = m[1];
    if (name !== SITE_MARKER && name !== SITE_EXEMPTION_MARKER) continue;
    const rest = m[2].trim();
    const exempt = name === SITE_EXEMPTION_MARKER;
    // The two markers order their operands differently, and both spellings are
    // load-bearing: a site names the TYPE first (`construction-site: Finding`),
    // an exemption names the DECISION first (`contract-construction-sites:
    // exempt — Finding is host-authored`). Parse the exemption's type out of the
    // text after `exempt`; a body with no `exempt` token at all is malformed and
    // is reported as an empty type rather than silently read as a site.
    let body = rest;
    if (exempt) {
      const m2 = rest.match(/^exempt\b[:—\-\s]*(.*)$/i);
      body = m2 ? m2[1].trim() : "";
    }
    const [type, ...noteParts] = body.split(/[ \t]+/);
    const note = noteParts.join(" ").trim();
    found.push({
      type: type ?? "",
      note,
      exempt,
      fields: parseMarkerFields(note),
    });
  }
  return found;
}

/** One file's markers, keyed by the path the caller reported. */
export interface FileSiteMarkers {
  readonly file: string;
  readonly markers: readonly SiteMarker[];
}

/** A contract type's declared sites, as the walker found them. */
export interface DerivedSites {
  readonly type: string;
  readonly sites: readonly string[];
  readonly exemptions: readonly string[];
  /**
   * Every field name the type's construction-site markers DECLARED, de-duplicated
   * and sorted. Empty is the norm — a marker need not name fields — and an empty
   * list makes no claim, which is why the reconciliation skips it rather than
   * reading the absence as a failure.
   */
  readonly fields: readonly string[];
}

/** The derived site map, plus markers naming a type the registry does not hold. */
export interface DerivedSiteMap {
  /** One entry per REGISTRY type, whether or not anything declares it. */
  readonly sites: Map<string, DerivedSites>;
  /** Markers naming an unknown contract type — a typo or a removed row. */
  readonly unknown: readonly string[];
}

/**
 * Derive, per contract type, the producer files that declare a construction site.
 *
 * `files` is the whole tracked listing paired with its text — the caller supplies
 * `git ls-files` and reads, so this stays pure and the gate can be driven against
 * a fixture tree. `types` is every contract type the registry holds; a registry
 * type nothing declares gets an EMPTY entry rather than no entry, so the walk
 * reports "no site" instead of reporting nothing.
 */
export function deriveConstructionSites(
  files: readonly FileSiteMarkers[],
  types: readonly string[],
): DerivedSiteMap {
  const byType = new Map<
    string,
    { sites: Set<string>; exemptions: Set<string>; fields: Set<string> }
  >(
    types.map((type) => [
      type,
      { sites: new Set<string>(), exemptions: new Set<string>(), fields: new Set<string>() },
    ]),
  );
  const unknown: string[] = [];
  for (const { file, markers } of files) {
    if (!isProducerPath(file)) continue;
    for (const marker of markers) {
      if (marker.type === "") continue;
      const entry = byType.get(marker.type);
      // A marker naming a type the registry does not hold is a typo or a
      // removed contract. Dropping it silently would let the registry shrink
      // while its sites still read as declared, so it is reported.
      if (!entry) {
        unknown.push(`${file} declares a construction site for unknown contract type "${marker.type}"`);
        continue;
      }
      for (const field of marker.fields) entry.fields.add(field);
      if (marker.exempt) entry.exemptions.add(file);
      else entry.sites.add(file);
    }
  }
  const sites = new Map<string, DerivedSites>();
  for (const [type, entry] of byType) {
    sites.set(type, {
      type,
      sites: [...entry.sites].sort(),
      exemptions: [...entry.exemptions].sort(),
      fields: [...entry.fields].sort(),
    });
  }
  return { sites, unknown };
}

// ── the OTHER half: a producer whose output IS a rendered schema ─────────────
//
// A schema generator is a producer in the sense that matters — its output has to
// carry a field the contract added — but there is no object literal to mark, so
// the derivation reads its OUTPUT instead. The rendered JSON Schema and the
// canonical zod contract must carry the SAME property set; a difference in
// either direction is the CI-only failure this gate exists to move to commit
// time.
//
// Read out of the shared contract as DATA (the JSON Schema's `properties` keys
// and `required` array), never through zod: the gate runs from the pre-commit
// skeleton, which has no build.

/** The slice of a rendered JSON Schema this walk reads. */
export interface RenderedJsonSchema {
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
}

/** A contract's field set: every property, and which of them are required. */
export interface ContractFieldSet {
  readonly properties: ReadonlySet<string>;
  readonly required: ReadonlySet<string>;
}

/**
 * Compare a rendered JSON Schema against the canonical contract it is rendered
 * from. `message` is the caller's refusal sentence — the remedy differs by which
 * schema moved, so the words belong to the caller that knows.
 *
 * `markerFields` / `declaredExceptions` are the DECLARED-MARKER half (optional —
 * see the block below): every field name the type's construction-site markers
 * name, and the names the registry's own rows permit beyond the contract. Both
 * default to empty, which disables the check rather than failing it.
 */
export function reconcileRenderedSchema(
  {
    schemaFile,
    rendered,
    contract,
    message,
    markerFields,
    declaredExceptions,
  }: {
    schemaFile: string;
    rendered: RenderedJsonSchema;
    contract: ContractFieldSet;
    message: string;
    markerFields?: readonly string[];
    declaredExceptions?: readonly string[];
  },
): string[] {
  const errors: string[] = [];
  const renderedProps = new Set(Object.keys(rendered.properties ?? {}));

  const missing = [...contract.properties].filter((p) => !renderedProps.has(p)).sort();
  const extra = [...renderedProps].filter((p) => !contract.properties.has(p)).sort();

  if (missing.length > 0) {
    errors.push(
      `${schemaFile} is MISSING ${missing.length} field(s) the contract declares ` +
        `(${missing.join(", ")}) — ${message}`,
    );
  }
  if (extra.length > 0) {
    errors.push(
      `${schemaFile} declares ${extra.length} field(s) the contract does not ` +
        `(${extra.join(", ")}) — ${message}`,
    );
  }

  // ── the other direction: a DECLARED MARKER naming a field the contract lacks ──
  //
  // The walk's declared sites are what the earlier half of this module derives,
  // and a declared site was never held to the contract's actual fields — only to
  // being PRESENT. That made the marker a claim about the site rather than about
  // the contract: a marker annotating a field the contract does not declare (a
  // site that has drifted off the contract, or one copied onto a consumer)
  // satisfied the derivation while asserting something false about the type.
  //
  // This is the field-set half the walk CAN prove mechanically, because a marker
  // carries field names — free text, not a literal — so the comparison needs no
  // dataflow analysis and has no false-positive shape: a name in `fields` that is
  // neither a property nor a declared exception is wrong, whichever file it is in.
  //
  // `markerFields` is injected (the caller derives it from `parseSiteMarkers`, so
  // this module keeps one parser). Absent = the caller did not derive fields for
  // this type, and NOTHING is inferred from the silence: a check that reds on a
  // caller that simply did not supply the input is a gate that cries wolf on its
  // own wiring.
  const declared = markerFields ?? [];
  if (declared.length > 0) {
    const known = new Set(contract.properties);
    for (const exception of declaredExceptions ?? []) known.add(exception);
    const undeclared = [...new Set(declared)].filter((f) => !known.has(f)).sort();
    if (undeclared.length > 0) {
      errors.push(
        `${schemaFile}: a construction-site marker declares ${undeclared.length} field(s) the ` +
          `contract does not (${undeclared.join(", ")}) — a marker sits AT a construction site and ` +
          `names a field of THAT contract, so an undeclared name means the site has drifted off ` +
          `this type (or the marker was copied onto a consumer). Fields the contract does not ` +
          `declare can only be named through an explicit exemption.`,
      );
    }
  }
  return errors;
}
