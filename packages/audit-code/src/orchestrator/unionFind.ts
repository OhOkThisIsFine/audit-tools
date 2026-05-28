export class UnionFind {
  private readonly parent: Map<string, string>;

  constructor(keys: Iterable<string>) {
    this.parent = new Map([...keys].map((key) => [key, key]));
  }

  find(key: string): string {
    const current = this.parent.get(key) ?? key;
    if (current === key) return key;
    const root = this.find(current);
    this.parent.set(key, root);
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
