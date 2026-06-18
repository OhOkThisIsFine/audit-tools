/**
 * claude-code emits structured JSON, one object per line, interleaved with
 * non-JSON noise on stderr. Both claude-code strategies — the shared error
 * parser and audit-code's header extractor — scanned that stream with a
 * near-identical loop: split on newlines, trim, keep only `{`-prefixed lines,
 * `JSON.parse` each, and silently skip the ones that are not valid JSON objects.
 *
 * `collectClaudeCodeJsonLines` is that single scan (drift-plan E5). It returns
 * every successfully-parsed JSON *object* line as a plain record; callers apply
 * their own field predicate (rate-limit fields, header fields, …). Non-object
 * JSON (arrays, bare numbers/strings) and parse failures are skipped — the
 * claude-code contract only emits objects per line.
 */
export function collectClaudeCodeJsonLines(
  stderr: string,
): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not valid JSON — skip (matches the prior best-effort scan).
      continue;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      objects.push(parsed as Record<string, unknown>);
    }
  }
  return objects;
}
