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

  return { phases, has_cycle: hasCycle };
}

/**
 * Build {@link PhaseCutModule}s from drafted/finalized module contracts whose
 * modules carry directional `neighbor_needs` (`{ neighbor, needs }` — this module
 * needs `neighbor`). A module that needs another is one tier ABOVE it, so the
 * derived `depends_on` for module M is the set of neighbours M needs. Tolerant of
 * malformed payloads: anything unparseable contributes no module/edge.
 */
export function phaseCutModulesFromContracts(contractsPayload: unknown): PhaseCutModule[] {
  const root = contractsPayload as { module_contracts?: unknown } | undefined;
  const list = Array.isArray(root?.module_contracts) ? root!.module_contracts : [];
  const out: PhaseCutModule[] = [];
  for (const mod of list) {
    if (typeof mod !== "object" || mod === null) continue;
    const m = mod as { name?: unknown; neighbor_needs?: unknown };
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    const needs = Array.isArray(m.neighbor_needs) ? m.neighbor_needs : [];
    const depends_on: string[] = [];
    for (const need of needs) {
      if (typeof need === "object" && need !== null) {
        const neighbor = (need as { neighbor?: unknown }).neighbor;
        if (typeof neighbor === "string" && neighbor.length > 0) depends_on.push(neighbor);
      }
    }
    out.push({ name: m.name, depends_on });
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
