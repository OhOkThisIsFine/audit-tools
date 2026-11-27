// sites-pinned: tests/audit-smoke.test.mjs
/** Build the manifest's path-to-byte-count index without rereading files. */
export function sizeIndexFromManifest(
  repoManifest?: { files: ReadonlyArray<{ path: string; size_bytes: number }> },
): Record<string, number> {
  if (!repoManifest) return {};
  return Object.fromEntries(
    repoManifest.files.map((file) => [file.path, file.size_bytes]),
  );
}
