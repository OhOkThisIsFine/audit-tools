/**
 * Deterministic phase-cut derivation (remediator auto-phasing, T3).
 *
 * When `/remediate-code` is pointed at an arbitrary N-goal input (e.g. the whole
 * backlog), the independent conceptual-design critique used to reject the run as
 * "over-scoped" and the HOST had to manually re-scope to a phase at intake. That
 * is the tool's job, not the host's: given the module-dependency DAG (each module
 * declares the neighbours it `needs`), the tool derives a foundations→consumers
 * phase cut MECHANICALLY — ordered tiers where every module sits one tier below
 * the modules that depend on it. The critique is then handed the derived cut, so
 * it assesses design quality WITHIN a mechanically dependency-ordered phasing
 * rather than rejecting breadth (over-scoping is already handled by construction).
 *
 * Pure + deterministic (no I/O, no Date/Math.random, stable ordering): the same
 * modules always yield the same cut. Cycle-safe — a dependency cycle cannot be
 * topologically tiered, so its members are placed together at the tier just past
 * their highest acyclic dependency (named-sorted, fail toward a LATER tier so a
 * cyclic module never front-runs a real foundation it transitively needs).
 */

/** One module + the names of the other modules it depends on (its foundations). */
export interface PhaseCutModule {
  name: string;
  /** Names of modules this module needs in place first (directional: this → dep). */
  depends_on: string[];
}

/** One derived phase: an ordered tier of modules that may be authored together. */
export interface PhaseCutPhase {
  /** 0-based tier ordinal; 0 = foundations. */
  ordinal: number;
  /** Stable human label for the tier. */
  name: string;
  /** Module names in this tier, sorted for determinism. */
  modules: string[];
}

/** The derived phase cut: ordered tiers covering every module exactly once. */
export interface PhaseCut {
  phases: PhaseCutPhase[];
  /** True when a dependency cycle was detected (its members were tiered together). */
  has_cycle: boolean;
  /** Module name → 0-based phase ordinal (foundations = 0). The downstream key. */
  module_phase: Record<string, number>;
}

/** Stable label for a tier ordinal. */
function phaseName(ordinal: number, lastOrdinal: number): string {
  if (ordinal === 0) return "foundations";
  if (ordinal === lastOrdinal) return "integration";
  return `consumers-${ordinal}`;
}

/**
 * Derive the ordered phase cut from a module-dependency DAG. Each module's tier is
 * the length of its longest dependency chain (foundations = 0). Edges to unknown
 * module names are ignored (a `needs` on a module not in scope is not a phase
 * constraint here). Returns one phase per occupied tier, covering every module.
 */
export function derivePhaseCut(modules: PhaseCutModule[]): PhaseCut {
  const names = modules.map((m) => m.name);
  const known = new Set(names);
  // Normalize edges: keep only deps that name a real in-scope module, drop self-edges.
  const deps = new Map<string, string[]>();
  for (const m of modules) {
    deps.set(
      m.name,
      [...new Set(m.depends_on)].filter((d) => d !== m.name && known.has(d)),
    );
  }

  // Longest-dependency-chain tier via memoized DFS with cycle detection. A node on
  // an active path (cycle) resolves to the max tier of its already-settled deps + 1
  // (fail toward a later tier), and the cycle flag is raised.
  const tier = new Map<string, number>();
  const visiting = new Set<string>();
  let hasCycle = false;

  const computeTier = (name: string): number => {
    const cached = tier.get(name);
    if (cached !== undefined) return cached;
    if (visiting.has(name)) {
      // Back-edge: a cycle. Don't recurse through it; treat as no added depth here.
      hasCycle = true;
      return 0;
    }
    visiting.add(name);
    let maxDep = -1;
    // Sort deps for deterministic traversal (tier values are order-independent, but
    // keep traversal stable for predictability under future changes).
    for (const d of [...(deps.get(name) ?? [])].sort()) {
      maxDep = Math.max(maxDep, computeTier(d));
    }
    visiting.delete(name);
    const t = maxDep + 1;
    tier.set(name, t);
    return t;
  };

  for (const name of [...names].sort()) computeTier(name);

  const lastOrdinal = Math.max(0, ...[...tier.values()]);
  const byTier = new Map<number, string[]>();
  for (const [name, t] of tier) {
    const bucket = byTier.get(t) ?? [];
    bucket.push(name);
    byTier.set(t, bucket);
  }

  const phases: PhaseCutPhase[] = [];
  for (let ordinal = 0; ordinal <= lastOrdinal; ordinal++) {
    const members = byTier.get(ordinal);
    if (!members || members.length === 0) continue;
    phases.push({
      ordinal,
      name: phaseName(ordinal, lastOrdinal),
      modules: [...members].sort(),
    });
  }

  const module_phase: Record<string, number> = {};
  for (const [name, t] of tier) module_phase[name] = t;

  return { phases, has_cycle: hasCycle, module_phase };
}

/**
 * Lowercase-hyphenate a module name into the id fragment the obligation-ledger
 * derivation uses (`OBL-<slug>-…`). MUST stay in lockstep with `slug` in
 * `derive.ts` — single-sourced here so the node→phase mapping decodes the exact
 * fragment the ledger encoded. (Both reduce to lowercase, non-alphanumeric→`-`.)
 */
export function moduleSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Resolve the phase ordinal for an implementation-DAG node from the obligation
 * ids it discharges. Every derived obligation id is `OBL-<moduleSlug>-…`, so the
 * owning module (hence phase) is recoverable by longest-slug prefix match — no
 * lossy slug reversal. A node spanning modules in several phases takes the MAX
 * ordinal (fail-toward-later: it cannot land before the latest module it touches
 * is reachable). A node whose obligations match no in-scope module slug — a
 * counterexample-only node, or an obligation from a module dropped from the cut —
 * defaults to the LAST phase (integration), never front-running a foundation.
 *
 * `slugToOrdinal` is the module-phase map re-keyed by `moduleSlug(name)`.
 */
export function phaseOrdinalForObligations(
  obligationIds: readonly string[],
  slugToOrdinal: Map<string, number>,
  lastOrdinal: number,
): number {
  // Longest-first so a slug that is a prefix of another (e.g. `auth` vs
  // `auth-service`) resolves to the most specific module.
  const slugsByLength = [...slugToOrdinal.keys()].sort((a, b) => b.length - a.length);
  let max = -1;
  let matchedAny = false;
  for (const id of obligationIds) {
    if (!id.startsWith("OBL-")) continue;
    const rest = id.slice(4);
    for (const slug of slugsByLength) {
      if (rest === slug || rest.startsWith(`${slug}-`)) {
        max = Math.max(max, slugToOrdinal.get(slug) ?? 0);
        matchedAny = true;
        break;
      }
    }
  }
  return matchedAny ? max : lastOrdinal;
}

/**
 * A structured artifact reference embedded anywhere inside a module's free-prose
 * `inputs`/`outputs` string: the token `artifact:<name>`, where `<name>` is a
 * stable identifier (letters, digits, `_`, `-`, `.`, `/`). The rest of the string
 * stays human prose. A module PRODUCES every artifact token in its `outputs` and
 * CONSUMES every token in its `inputs`; the tool matches producer→consumer to
 * derive data-flow ordering, so the ordering is tool-enforced from the finalized
 * contracts rather than relying on the host to hand-add `depends_on` edges.
 * Matching is case-insensitive so `artifact:Roster` (produced) and `artifact:roster`
 * (consumed) still pair.
 */
const ARTIFACT_TOKEN_PATTERN = /\bartifact:([A-Za-z0-9_./-]+)/gi;

/** The normalized artifact names referenced by a module's inputs/outputs list. */
function extractArtifactNames(entries: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(entries)) return names;
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    for (const match of entry.matchAll(ARTIFACT_TOKEN_PATTERN)) {
      // Trim trailing separator/punctuation the greedy class may have swallowed
      // (e.g. a token ending a sentence: "artifact:roster.").
      const name = match[1].replace(/[._/-]+$/, "").toLowerCase();
      if (name.length > 0) names.add(name);
    }
  }
  return names;
}

/**
 * Derive directional module-dependency edges from producer/consumer artifact
 * tokens in the finalized contracts' `inputs`/`outputs`. For each module M and
 * each artifact M consumes (an `artifact:<name>` token in M's `inputs`), M depends
 * on every OTHER module that produces that artifact (the token in its `outputs`).
 * Returns module name → set of module names it depends on (must run first).
 * Tolerant of malformed payloads: anything unparseable contributes no edge.
 */
function deriveModuleArtifactDependencies(
  contractsPayload: unknown,
): Map<string, Set<string>> {
  const root = contractsPayload as { module_contracts?: unknown } | undefined;
  const list = Array.isArray(root?.module_contracts) ? root!.module_contracts : [];
  const producers = new Map<string, Set<string>>(); // artifact name → producing modules
  const consumes = new Map<string, Set<string>>(); // module name → consumed artifact names
  const moduleNames: string[] = [];
  for (const mod of list) {
    if (typeof mod !== "object" || mod === null) continue;
    const m = mod as { name?: unknown; inputs?: unknown; outputs?: unknown };
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    moduleNames.push(m.name);
    for (const artifact of extractArtifactNames(m.outputs)) {
      const set = producers.get(artifact) ?? new Set<string>();
      set.add(m.name);
      producers.set(artifact, set);
    }
    consumes.set(m.name, extractArtifactNames(m.inputs));
  }
  const deps = new Map<string, Set<string>>();
  for (const name of moduleNames) {
    const set = new Set<string>();
    for (const artifact of consumes.get(name) ?? []) {
      for (const producer of producers.get(artifact) ?? []) {
        if (producer !== name) set.add(producer);
      }
    }
    deps.set(name, set);
  }
  return deps;
}

/**
 * Build {@link PhaseCutModule}s from drafted/finalized module contracts. A module's
 * `depends_on` is the UNION of two tool-derived signals: (1) any directional
 * `neighbor_needs` (`{ neighbor, needs }` — this module needs `neighbor`, present
 * on DRAFT contracts) and (2) producer/consumer artifact-token matching over
 * `inputs`/`outputs` (present on FINALIZED contracts, which drop `neighbor_needs`).
 * A module that needs/consumes from another is one tier ABOVE it. Tolerant of
 * malformed payloads: anything unparseable contributes no module/edge.
 */
export function phaseCutModulesFromContracts(contractsPayload: unknown): PhaseCutModule[] {
  const root = contractsPayload as { module_contracts?: unknown } | undefined;
  const list = Array.isArray(root?.module_contracts) ? root!.module_contracts : [];
  const artifactDeps = deriveModuleArtifactDependencies(contractsPayload);
  const out: PhaseCutModule[] = [];
  for (const mod of list) {
    if (typeof mod !== "object" || mod === null) continue;
    const m = mod as { name?: unknown; neighbor_needs?: unknown };
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    const needs = Array.isArray(m.neighbor_needs) ? m.neighbor_needs : [];
    const depends_on = new Set<string>();
    for (const need of needs) {
      if (typeof need === "object" && need !== null) {
        const neighbor = (need as { neighbor?: unknown }).neighbor;
        if (typeof neighbor === "string" && neighbor.length > 0) depends_on.add(neighbor);
      }
    }
    for (const dep of artifactDeps.get(m.name) ?? []) depends_on.add(dep);
    out.push({ name: m.name, depends_on: [...depends_on] });
  }
  return out;
}

/** Render the derived phase cut as a markdown section for the critique prompt. */
export function renderPhaseCutSection(cut: PhaseCut): string {
  const lines = cut.phases.map(
    (p) => `- **Phase ${p.ordinal} — ${p.name}** (${p.modules.length} module(s)): ${p.modules.join(", ")}`,
  );
  return `## Mechanically-Derived Phase Cut

This change is **not** executed as one monolithic landing. The tool derived the
following ordered, dependency-gated phase cut from the module-dependency DAG —
each phase's modules depend only on earlier phases, and the scheduler enforces the
ordering with mechanical dependencies (a later-phase module cannot dispatch until
its foundations are verified-complete, with a whole-repo green gate between phases):

${lines.join("\n")}

Assess the **design quality** within this phasing. Do NOT reject the work as
"over-scoped" or "too large for one change" — breadth is already handled by
construction: the phases land incrementally, green at every commit. Flag a real
design problem (a wrong boundary, a missing invariant, an unsound seam), not the
number of modules.${cut.has_cycle ? "\n\n> NOTE: a dependency cycle was detected among the modules; its members were tiered together. A genuine circular dependency between modules is a design smell worth your scrutiny." : ""}`;
}
