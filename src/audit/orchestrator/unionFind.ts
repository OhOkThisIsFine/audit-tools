export class UnionFind {
  private readonly parent: Map<string, string>;

  constructor(keys: Iterable<string>) {
    this.parent = new Map([...keys].map((key) => [key, key]));
  }

  find(key: string): string {
    // COR-b6f68ad7: iterative path compression avoids unbounded recursion that
    // could stack-overflow on degenerate union chains.
    //
    // Phase 1: walk up to find the root.
    let root = this.parent.get(key) ?? key;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    // Phase 2: path compress — point every node on the path directly to root.
    let current = key;
    while (current !== root) {
      const next = this.parent.get(current) ?? root;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const [keep, move] =
      rootA.localeCompare(rootB) <= 0 ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(move, keep);
  }

  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const group = result.get(root) ?? [];
      group.push(key);
      result.set(root, group);
    }
    return result;
  }
}
