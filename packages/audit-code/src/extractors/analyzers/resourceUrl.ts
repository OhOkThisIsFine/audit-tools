import { posix } from "node:path";
import { normalizeGraphPath, resolveCandidate } from "../graphPathUtils.js";

// Protocol (http:, data:, mailto:, …), protocol-relative (//), and fragment (#)
// URLs point outside the repository and are never resolved to a local file.
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Resolve an HTML/CSS resource reference (script src, link href, @import, url())
 * to a repo-relative file path, or undefined. Root-relative URLs ("/assets/x")
 * resolve from the repo root; everything else is relative to the referencing
 * file. Query strings and fragments are stripped before resolution.
 */
export function resolveResourceUrl(
  fromPath: string,
  url: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0 || EXTERNAL_URL_PATTERN.test(trimmed)) {
    return undefined;
  }
  const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (withoutQuery.length === 0) {
    return undefined;
  }
  const candidate = withoutQuery.startsWith("/")
    ? withoutQuery.slice(1)
    : posix.join(posix.dirname(normalizeGraphPath(fromPath)), withoutQuery);
  return resolveCandidate(candidate, pathLookup);
}
