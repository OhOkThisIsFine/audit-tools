export function analyzerManifestPathSet(manifest?: { files: readonly { path: string }[] }): ReadonlySet<string> | undefined {
  return manifest && new Set(manifest.files.map(file => file.path));
}

/** The artifact validator admits exact normalized manifest paths, not live paths. */
export function analyzerPathMembership(paths?: ReadonlySet<string>): (path: string) => boolean {
  return paths === undefined ? () => true : path => paths.has(path);
}

export function admitAnalyzerRows<T extends { path: string }>(
  rows: T[],
  isAdmitted: (path: string) => boolean,
): { admitted: T[]; omitted: number } {
  const admitted = rows.filter(row => isAdmitted(row.path));
  return { admitted, omitted: rows.length - admitted.length };
}

export function analyzerScopeDiagnostic(omitted: number): string {
  return omitted ? ` Omitted ${omitted} finding(s) outside the frozen manifest scope.` : "";
}
