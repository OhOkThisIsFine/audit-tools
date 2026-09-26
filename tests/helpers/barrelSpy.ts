// Barrel-spy detection, single-sourced (T44 / durable-traps "A `vi.spyOn` on the
// `audit-tools/shared` re-export barrel passes VACUOUSLY"). Spying a symbol on
// the `audit-tools/shared` barrel namespace object does NOT intercept a consumer
// that imported that symbol directly — the source holds its own bound reference,
// so the spy records zero calls and any assertion over `spy.mock.calls` is green
// while exercising nothing.
//
// It was mechanically guarded ONLY under tests/remediate; tests/audit and
// tests/shared were unguarded and had to be verified by hand. The invariant
// (INV-remediate-tests-12) now scans all three areas through this shared
// detector, so a bad spy fails wherever it lands.
//
// Built-in targets (`process.*`, `console.*`) and relative source-module
// namespaces (`import * as x from "../../src/…"`) are a DIFFERENT mechanism — a
// relative import binds the actual module object, not a re-export facade — so
// they are allowed and are never detected.

/** Variables bound to the audit-tools/shared barrel as a full namespace object. */
export function barrelNamespaceVars(src: string): string[] {
  const names = new Set<string>();
  // `const NS = await import("audit-tools/shared…")` — a `{`-destructure never
  // matches (no identifier after `const`), so only namespace bindings are caught.
  for (const m of src.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']audit-tools\/shared/g,
  )) {
    names.add(m[1]);
  }
  // `import * as NS from "audit-tools/shared…"`
  for (const m of src.matchAll(
    /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["']audit-tools\/shared/g,
  )) {
    names.add(m[1]);
  }
  return [...names];
}

/** `file: vi.spyOn(<ns>, …)` violations — a non-empty list means a bad barrel spy. */
export function barrelSpyViolations(src: string): string[] {
  const nonComment = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return barrelNamespaceVars(nonComment).filter((name) =>
    new RegExp(`vi\\.spyOn\\(\\s*${name}\\b`).test(nonComment),
  );
}
