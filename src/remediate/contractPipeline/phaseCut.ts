/**
 * Deterministic phase-cut derivation (remediator auto-phasing, T3).
 *
 * When `/remediate-code` is pointed at an arbitrary N-goal input (e.g. the whole
 * backlog), the independent conceptual-design critique used to reject the run as
 * "over-scoped" and the HOST had to manually re-scope to a phase at intake. That
 * is the tool's job, not the host's: given the module-dependency DAG (the
 * producer/consumer `artifact:<name>` token edges declared in the contracts'
 * inputs/outputs), the tool derives a foundations→consumers
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

import { OBLIGATION_PREFIX } from "./idRegistry.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { findCyclicComponents } from "../../shared/graph/directedCycles.js";

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
 * The id fragment obligation ids encode — re-exported from the id registry,
 * which owns both this and the mint that produces `OBL-<slug>-…`, so encoder and
 * decoder cannot drift. Kept exported here because this module is where the
 * node→phase decoders live and import it from.
 */
export { moduleSlug } from "./idRegistry.js";

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
    const slug = moduleSlugForObligationId(id, slugsByLength);
    if (slug === null) continue;
    max = Math.max(max, slugToOrdinal.get(slug) ?? 0);
    matchedAny = true;
  }
  return matchedAny ? max : lastOrdinal;
}

/**
 * The ONE longest-prefix slug match for an `OBL-<moduleSlug>-…` obligation id.
 * `slugsByLength` MUST be sorted longest-first (the callers own the sort so a
 * hot loop sorts once). Returns the matched slug, or null when the id carries
 * no obligation prefix or matches no known module — shared by the phase-ordinal
 * decoder above and the promotion's module-contract attachment
 * (open-bugs.md:474), so the two decoders cannot drift.
 */
export function moduleSlugForObligationId(
  obligationId: string,
  slugsByLength: readonly string[],
): string | null {
  if (!obligationId.startsWith(OBLIGATION_PREFIX)) return null;
  const rest = obligationId.slice(OBLIGATION_PREFIX.length);
  for (const slug of slugsByLength) {
    if (rest === slug || rest.startsWith(`${slug}-`)) return slug;
  }
  return null;
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

/** One producer→consumer pairing and the artifact token that links it. */
interface ArtifactTokenEdge {
  /** The depending module — it consumes the artifact. */
  consumer: string;
  /** The module it depends on — it produces the artifact. */
  producer: string;
  /** The normalized artifact name from the `artifact:<name>` token. */
  artifact: string;
}

/**
 * Derive the DECLARED module-dependency graph from producer/consumer artifact
 * tokens in the contracts' `inputs`/`outputs`. For each module M and each
 * artifact M consumes (an `artifact:<name>` token in M's `inputs`), M depends
 * on every OTHER module that produces that artifact (the token in its
 * `outputs`). Returns both the dependency map (module name → set of module
 * names that must run first) and the per-edge artifact attribution, so a cycle
 * can be reported with the exact tokens that form it. Tolerant of malformed
 * payloads: anything unparseable contributes no edge.
 */
function deriveModuleArtifactGraph(contractsPayload: unknown): {
  deps: Map<string, Set<string>>;
  edges: ArtifactTokenEdge[];
} {
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
  const edges: ArtifactTokenEdge[] = [];
  for (const name of moduleNames) {
    const set = new Set<string>();
    for (const artifact of consumes.get(name) ?? []) {
      for (const producer of producers.get(artifact) ?? []) {
        if (producer === name) continue;
        set.add(producer);
        edges.push({ consumer: name, producer, artifact });
      }
    }
    deps.set(name, set);
  }
  return { deps, edges };
}

/**
 * Build {@link PhaseCutModule}s from finalized module contracts. A module's
 * `depends_on` derives from producer/consumer artifact-token matching over
 * `inputs`/`outputs` ALONE. Drafted `neighbor_needs` never enter this graph
 * (open-bugs.md:106): they are symmetric coordination prose whose directions
 * per-module drafting agents routinely invert, and unioning them in let prose
 * override every declared token edge — finalization drops the field instead.
 * A module that consumes from another is one tier ABOVE it. Tolerant of
 * malformed payloads: anything unparseable contributes no module/edge.
 */
export function phaseCutModulesFromContracts(contractsPayload: unknown): PhaseCutModule[] {
  const root = contractsPayload as { module_contracts?: unknown } | undefined;
  const list = Array.isArray(root?.module_contracts) ? root!.module_contracts : [];
  const { deps } = deriveModuleArtifactGraph(contractsPayload);
  const out: PhaseCutModule[] = [];
  for (const mod of list) {
    if (typeof mod !== "object" || mod === null) continue;
    const m = mod as { name?: unknown };
    if (typeof m.name !== "string" || m.name.length === 0) continue;
    out.push({ name: m.name, depends_on: [...(deps.get(m.name) ?? [])] });
  }
  return out;
}

/** One declared-graph cycle: its member modules and the token edges among them. */
export interface ContractTokenCycle {
  /** Cycle members, in stable input order. */
  members: string[];
  /** The consumer→producer token edges between cycle members. */
  edges: ArtifactTokenEdge[];
}

/**
 * Detect cycles in the DECLARED module-dependency graph — the producer/consumer
 * `artifact:` token edges of a module-contracts payload (drafted or finalized;
 * finalization copies `inputs`/`outputs` verbatim, so the two graphs are equal).
 * A cycle here is a VALIDATION error at the contract boundary (open-bugs.md:106):
 * the phase cut must never be derived over a cyclic declared graph, because the
 * fail-toward-later tiering silently drops a back-edge and places token
 * consumers ahead of their producers. Members and their linking edges are
 * reported so the repair prompt can name exactly which tokens form each cycle.
 */
export function detectContractTokenCycles(contractsPayload: unknown): ContractTokenCycle[] {
  const { deps, edges } = deriveModuleArtifactGraph(contractsPayload);
  const components = findCyclicComponents(
    [...deps.entries()].map(([id, dependsOn]) => ({ id, depends_on: [...dependsOn] })),
  );
  return components.map((members) => {
    const memberSet = new Set(members);
    return {
      members,
      edges: edges.filter((e) => memberSet.has(e.consumer) && memberSet.has(e.producer)),
    };
  });
}

/**
 * Add Path-A seam-preparation edges to the contract-derived module DAG. The
 * decomposition gate has already guaranteed one preparer per required seam;
 * this projection makes every implementation module for either participating
 * work block depend on that preparer, yielding a seam-first phase followed by
 * parallel refactor modules.
 */
export function applyWorkBlockSeamDependencies(
  modules: PhaseCutModule[],
  moduleDecompositionPayload: unknown,
  pathASeedPayload: unknown,
): PhaseCutModule[] {
  const decomposition = moduleDecompositionPayload as { modules?: unknown } | undefined;
  const decomposed = Array.isArray(decomposition?.modules) ? decomposition!.modules : [];
  const seed = pathASeedPayload as { work_block_seams?: unknown } | undefined;
  const seams = Array.isArray(seed?.work_block_seams) ? seed!.work_block_seams : [];
  if (decomposed.length === 0 || seams.length === 0) return modules;

  const sourceBlocksByModule = new Map<string, Set<string>>();
  const preparerBySeam = new Map<string, string>();
  for (const value of decomposed) {
    if (typeof value !== "object" || value === null) continue;
    const mod = value as {
      name?: unknown;
      source_work_block_ids?: unknown;
      prepares_seam_ids?: unknown;
    };
    if (typeof mod.name !== "string") continue;
    sourceBlocksByModule.set(
      mod.name,
      new Set(
        Array.isArray(mod.source_work_block_ids)
          ? mod.source_work_block_ids.filter((id): id is string => typeof id === "string")
          : [],
      ),
    );
    for (const seamId of Array.isArray(mod.prepares_seam_ids)
      ? mod.prepares_seam_ids
      : []) {
      if (typeof seamId === "string" && !preparerBySeam.has(seamId)) {
        preparerBySeam.set(seamId, mod.name);
      }
    }
  }

  const extraDeps = new Map<string, Set<string>>();
  for (const value of seams) {
    if (typeof value !== "object" || value === null) continue;
    const seam = value as {
      id?: unknown;
      block_ids?: unknown;
      requires_preparation?: unknown;
    };
    if (seam.requires_preparation !== true || typeof seam.id !== "string") continue;
    const preparer = preparerBySeam.get(seam.id);
    if (!preparer) continue;
    const blockIds = new Set(
      Array.isArray(seam.block_ids)
        ? seam.block_ids.filter((id): id is string => typeof id === "string")
        : [],
    );
    for (const [moduleName, sourceBlocks] of sourceBlocksByModule) {
      if (moduleName === preparer) continue;
      if (![...sourceBlocks].some((id) => blockIds.has(id))) continue;
      const deps = extraDeps.get(moduleName) ?? new Set<string>();
      deps.add(preparer);
      extraDeps.set(moduleName, deps);
    }
  }

  return modules.map((module) => ({
    ...module,
    depends_on: [
      ...new Set([...module.depends_on, ...(extraDeps.get(module.name) ?? [])]),
    ].sort((a, b) => compareCodeUnits(a, b)),
  }));
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
