// sites-pinned: tests/remediate/planning-graph.test.ts
import { join } from "node:path";
import { compareCodeUnits, hashContent, isSha256 } from "audit-tools/shared";

export const auditNavigationGraphPath = (directory: string) => join(directory, "audit-navigation-graph.json");

export function navigationSourceDigest(files: readonly { path: string; hash?: string }[]): string | undefined {
  if (files.some(file => file.hash === undefined || !isSha256(file.hash))) return undefined;
  return hashContent(JSON.stringify(files.map(({ path, hash }) => [path, hash] as const)
    .sort(([a], [b]) => compareCodeUnits(a, b))));
}
