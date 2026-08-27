/**
 * Directed-cycle primitives over an id + dependency-list graph — the ONE core
 * every cycle question in this package draws from.
 *
 * Four call sites used to ask the same question three hand-rolled ways: two
 * Kahn drains (the cyclic-seam detector and the design-spec circular-obligation
 * gate) and a recursive white/gray/black DFS (the obligation-ledger
 * construction guard and the implementation-DAG validator). The Kahn drains
 * were WRONG about membership: a Kahn remainder is "every node that never
 * reached in-degree zero", which includes every node DOWNSTREAM of a cycle, so
 * a tail that merely depends on a cycle member was reported as a member of the
 * cycle it can never be part of. Exact membership is the strongly connected
 * component, and that is what {@link findCyclicComponents} returns.
 *
 * Both traversals are ITERATIVE. A ledger or DAG reaching these functions is
 * host-authored, untrusted input of arbitrary depth; a recursive DFS over one
 * stack-overflows rather than reporting.
 *
 * Determinism is part of the contract — these results reach persisted artifacts
 * and prompt text. Component order, member order and the witness path all
 * follow the caller's input order, never Map/Set iteration accident.
 */

/** A node in a directed dependency graph: an id and the ids it depends on. */
interface DirectedGraphNode {
  /** Node identifier. Duplicate ids are normalized away (see below). */
  id: string;
  /** Ids this node depends on. Ids outside the input set are ignored. */
  depends_on: readonly string[];
}

interface DirectedCycleOptions {
  /**
   * Treat a self-edge (`id` → `id`) as a cycle: a 1-member component is
   * reported, and the witness may be `["A","A"]`. Default `false` — the
   * implementation-DAG validator deliberately strips self-edges.
   */
  includeSelfLoops?: boolean;
}

/** Normalized adjacency: duplicate nodes merged, external refs dropped. */
interface NormalizedGraph {
  /** Ids in first-occurrence input order — the ordering key for every result. */
  order: string[];
  /** id → dependency ids (known ids only, deduplicated, input order). */
  deps: Map<string, string[]>;
  /** Ids carrying a self-edge. */
  selfLoops: Set<string>;
}

const NO_DEPS: readonly string[] = [];

/**
 * Collapse the caller's node list into a clean adjacency map.
 *
 * MULTISET tolerance is deliberate: a caller may feed the same id twice (the
 * cycle-break re-check used to append a mediator that was already in the
 * graph). A duplicate id keeps its FIRST position and takes the union of every
 * occurrence's dependencies, so a duplicate with identical deps is exactly a
 * de-duplication. Dependencies naming an id outside the input set are external
 * references and are dropped, as is a repeated edge.
 */
function normalizeGraph(nodes: readonly DirectedGraphNode[]): NormalizedGraph {
  const order: string[] = [];
  const collected = new Map<string, string[]>();
  for (const node of nodes) {
    const existing = collected.get(node.id);
    if (existing === undefined) {
      order.push(node.id);
      collected.set(node.id, [...node.depends_on]);
    } else {
      existing.push(...node.depends_on);
    }
  }

  const known = new Set(order);
  const deps = new Map<string, string[]>();
  const selfLoops = new Set<string>();
  for (const id of order) {
    const seen = new Set<string>();
    const edges: string[] = [];
    for (const dep of collected.get(id) ?? NO_DEPS) {
      if (!known.has(dep) || seen.has(dep)) continue;
      seen.add(dep);
      if (dep === id) selfLoops.add(id);
      edges.push(dep);
    }
    deps.set(id, edges);
  }

  return { order, deps, selfLoops };
}

/** One iterative-traversal frame: the node, and how far its edge list is drained. */
interface TraversalFrame {
  id: string;
  next: number;
}

/**
 * Every CYCLIC strongly connected component of the graph — exact cycle
 * membership, with no downstream tail and no upstream feeder.
 *
 * A component qualifies when it holds two or more mutually reachable nodes, or
 * when it is a single node with a self-edge and `includeSelfLoops` is set.
 * Iterative Tarjan; components are ordered by their first member's input
 * position and members are listed in input order, so the result is stable
 * across runs and platforms.
 */
export function findCyclicComponents(
  nodes: readonly DirectedGraphNode[],
  options: DirectedCycleOptions = {},
): string[][] {
  const includeSelfLoops = options.includeSelfLoops === true;
  const { order, deps, selfLoops } = normalizeGraph(nodes);

  const position = new Map<string, number>();
  for (const [i, id] of order.entries()) position.set(id, i);

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const componentStack: string[] = [];
  const frames: TraversalFrame[] = [];
  const components: string[][] = [];
  let counter = 0;

  const open = (id: string): void => {
    index.set(id, counter);
    lowLink.set(id, counter);
    counter += 1;
    componentStack.push(id);
    onStack.add(id);
    frames.push({ id, next: 0 });
  };

  for (const root of order) {
    if (index.has(root)) continue;
    open(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const edges = deps.get(frame.id) ?? NO_DEPS;
      if (frame.next < edges.length) {
        const dep = edges[frame.next];
        frame.next += 1;
        if (!index.has(dep)) {
          open(dep);
        } else if (onStack.has(dep)) {
          lowLink.set(frame.id, Math.min(lowLink.get(frame.id) ?? 0, index.get(dep) ?? 0));
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        lowLink.set(
          parent.id,
          Math.min(lowLink.get(parent.id) ?? 0, lowLink.get(frame.id) ?? 0),
        );
      }
      if (lowLink.get(frame.id) === index.get(frame.id)) {
        const members: string[] = [];
        let popped: string | undefined;
        do {
          popped = componentStack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          members.push(popped);
        } while (popped !== frame.id);
        components.push(members);
      }
    }
  }

  const cyclic = components.filter(
    (members) =>
      members.length > 1 || (includeSelfLoops && selfLoops.has(members[0])),
  );
  for (const members of cyclic) {
    members.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  }
  cyclic.sort((a, b) => (position.get(a[0]) ?? 0) - (position.get(b[0]) ?? 0));
  return cyclic;
}

/**
 * The first cycle reachable in input order, as a witness PATH with its start
 * repeated at the end — `["A","B","A"]` — or `null` for an acyclic graph.
 *
 * This is the shape callers render into an error message, so it is a path, not
 * a set: it names the edges that close the loop. Iterative white/gray/black
 * DFS, visiting roots and each node's dependencies in input order, so the
 * reported cycle is the same one on every run. A self-edge yields `["A","A"]`
 * when `includeSelfLoops` is set, and is invisible otherwise.
 */
export function findFirstCycleWitness(
  nodes: readonly DirectedGraphNode[],
  options: DirectedCycleOptions = {},
): string[] | null {
  const includeSelfLoops = options.includeSelfLoops === true;
  const { order, deps } = normalizeGraph(nodes);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const path: string[] = [];
  const frames: TraversalFrame[] = [];

  for (const root of order) {
    if ((color.get(root) ?? WHITE) !== WHITE) continue;
    color.set(root, GRAY);
    path.push(root);
    frames.push({ id: root, next: 0 });

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const edges = deps.get(frame.id) ?? NO_DEPS;
      if (frame.next < edges.length) {
        const dep = edges[frame.next];
        frame.next += 1;
        if (dep === frame.id && !includeSelfLoops) continue;
        const seen = color.get(dep) ?? WHITE;
        if (seen === BLACK) continue;
        if (seen === GRAY) return path.slice(path.indexOf(dep)).concat(dep);
        color.set(dep, GRAY);
        path.push(dep);
        frames.push({ id: dep, next: 0 });
        continue;
      }
      color.set(frame.id, BLACK);
      path.pop();
      frames.pop();
    }
  }

  return null;
}
