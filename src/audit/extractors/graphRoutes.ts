// sites-pinned: tests/audit/graph-route-backtracking.test.ts, tests/audit/graph-framework-routes.test.ts
import type { GraphEdge, RouteEdge } from "audit-tools/shared";
import { compareCodeUnits } from "audit-tools/shared";
import { maskCommentSpans } from "./commentDecomposition.js";
import {
  graphEdge,
  normalizeGraphPath,
  resolveReferenceLiteral,
  resolveSpecifier,
  SOURCE_EXTENSIONS,
} from "./graphPathUtils.js";

const ROUTE_HANDLER_EDGE_CONFIDENCE = 0.92;

const ROUTE_REGISTRATION_PATTERN =
  /\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete|del|options|head|all)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/gi;
const ROUTE_OBJECT_PATTERN =
  /\b(?:app|router|server|fastify)\s*\.\s*route\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/gi;
const ROUTE_METHOD_EXPORT_PATTERN =
  /\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const ROUTE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "ALL",
]);
const REQUIRE_BINDING_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

// ── The two binding-clause scans (no regex over repo content) ────────────────
//
// "No regex over repo content" is the PROPERTY, not a coincidence of these two:
// the module's other patterns are bounded so that the property holds with them
// present (see the super-linearity suite in
// `tests/audit/graph-route-backtracking.test.ts`). A pattern added here later is
// bound by the same rule; these two were the sites where bounding was the wrong
// instrument, because the match they must keep is the LONG one a bound would
// drop.
//
// Both of these were regexes with an UNBOUNDED gap between two literals, and
// both were quadratic on adversarial input — `docs/reviews/analysis-tools-plan-
// 2026-08-07.md` §4/§5, measured at 12 → 49 → 194 → 800 ms per doubling for the
// import clause and the same shape for the destructuring one.
//
// The cost was never the quantifier; it was that a FAILING start position had to
// be expanded to the end before it could be known to fail, and every position in
// the file is a start position. Bounding the gap would fix the cost by silently
// dropping the long matches (`leads-not-verdicts` bought and paid for elsewhere,
// but unnecessary here). These scans instead keep EVERY match the regexes found
// and are linear by SKIPPING rather than stepping — the same correction
// `stripIdentifierTokens` (`src/remediate/contractPipeline/changeClassification.ts`)
// applies to its own bounded-token regex, and for the same reason: emitting a
// character and re-entering re-runs the same failing scan one position later,
// which is the quadratic relocated rather than removed.

/** `\s` — the character test both scans share with their regex predecessors. */
const WHITESPACE_CHARACTER = /\s/;

/** `[A-Za-z0-9_]`, the class JS `\b` treats as word characters. */
function isWordCharacterAt(content: string, index: number): boolean {
  if (index < 0 || index >= content.length) return false;
  const code = content.charCodeAt(index);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isWhitespaceAt(content: string, index: number): boolean {
  return (
    index >= 0 &&
    index < content.length &&
    WHITESPACE_CHARACTER.test(content[index]!)
  );
}

function skipWhitespace(content: string, from: number): number {
  let index = from;
  while (index < content.length && WHITESPACE_CHARACTER.test(content[index]!)) {
    index += 1;
  }
  return index;
}

/** End of the `;`-delimited segment containing `from` (the `;`, or EOF). */
function segmentEnd(content: string, from: number): number {
  const semicolon = content.indexOf(";", from);
  return semicolon === -1 ? content.length : semicolon;
}

interface ImportClauseMatch {
  /** Raw text between `import` (and any `type`) and `from`. */
  clause: string;
  specifier: string;
}

interface ImportTerminator {
  /** Where the clause ends — the start of the whitespace run before `from`. */
  clauseEnd: number;
  specifier: string;
  /** First index past the closing quote. */
  end: number;
}

/**
 * The first `\s+from\s+["']([^"']+)["']` at or after `clauseStart`, within the
 * current `;`-delimited segment — `null` when there is none.
 *
 * Lazy-clause semantics, stated: the clause takes as FEW characters as possible,
 * so this returns the FIRST `from` that completes the whole tail. A `from` whose
 * tail does not complete (no quote, empty specifier, mixed quote kinds) is
 * skipped and the search continues — exactly the backtracking the regex did,
 * minus the repeated start positions.
 */
function findImportTerminator(
  content: string,
  clauseStart: number,
): ImportTerminator | null {
  const limit = segmentEnd(content, clauseStart);
  let searchFrom = clauseStart;
  for (;;) {
    const at = content.indexOf("from", searchFrom);
    // `at >= limit`: the clause is `[^;]*?`, so it cannot cross a `;`.
    if (at === -1 || at >= limit) return null;
    searchFrom = at + 4;
    // `\s+from`, and `[^;"']` — the clause is non-empty and does not start here.
    if (at <= clauseStart || !isWhitespaceAt(content, at - 1)) continue;
    const quoteAt = skipWhitespace(content, at + 4);
    if (quoteAt === at + 4) continue;
    const quote = content[quoteAt];
    if (quote !== '"' && quote !== "'") continue;
    const closeAt = content.indexOf(quote, quoteAt + 1);
    // `[^"']+`: at least one character, and of THIS quote kind only.
    if (closeAt <= quoteAt + 1) continue;
    const specifier = content.slice(quoteAt + 1, closeAt);
    if (specifier.includes('"') || specifier.includes("'")) continue;
    return { clauseEnd: at, specifier, end: closeAt + 1 };
  }
}

/**
 * Every `\bimport\s+(?:type\s+)?CLAUSE\s+from\s+["']SPEC["']` in `content`, in
 * document order and non-overlapping (a match resumes the scan at its own end).
 *
 * THE SKIP. When `findImportTerminator` fails from a clause start, there is no
 * completing `from` anywhere in the REST OF THE SEGMENT. Every later `import` in
 * that segment searches a SUFFIX of the same region, so every one of them fails
 * too — the scan jumps to the segment's end instead of stepping past the
 * keyword. One failed scan per segment, whatever the marker count.
 */
function scanImportClauses(content: string): ImportClauseMatch[] {
  const matches: ImportClauseMatch[] = [];
  let index = 0;
  while (index < content.length) {
    const keyword = content.indexOf("import", index);
    if (keyword === -1) break;
    index = keyword + "import".length;
    // `\bimport` — the keyword inside an identifier is not one.
    if (isWordCharacterAt(content, keyword - 1)) continue;
    const afterKeyword = skipWhitespace(content, index);
    if (afterKeyword === index) continue;
    // `(?:type\s+)?` — optional, and only when the `type` is its own token.
    const clauseStart =
      content.startsWith("type", afterKeyword) &&
      isWhitespaceAt(content, afterKeyword + 4)
        ? skipWhitespace(content, afterKeyword + 4)
        : afterKeyword;
    // The clause's first character is `[^;"']` — what keeps a side-effect
    // `import "x"` from being read as a binding clause.
    const first = content[clauseStart];
    if (first === undefined || first === ";" || first === '"' || first === "'") {
      continue;
    }
    const terminator = findImportTerminator(content, clauseStart);
    if (!terminator) {
      index = segmentEnd(content, clauseStart);
      continue;
    }
    matches.push({
      clause: content.slice(clauseStart, terminator.clauseEnd),
      specifier: terminator.specifier,
    });
    index = terminator.end;
  }
  return matches;
}

/** `\b(?:const|let|var)\s+\{` — the head of a destructuring require. */
const REQUIRE_DESTRUCTURING_HEAD_PATTERN = /\b(?:const|let|var)\s+\{/g;

/**
 * `\s*=\s*require\s*\(\s*["']SPEC["']\s*\)`, anchored where it is placed.
 *
 * Sticky rather than global: the tail is only ever tried at one known offset (the
 * character after the closing brace), so there are no start positions to scan.
 */
const REQUIRE_DESTRUCTURING_TAIL_PATTERN =
  /\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/y;

interface DestructuringMatch {
  bindings: string;
  specifier: string;
}

/**
 * Every `\b(?:const|let|var)\s+\{BINDINGS\}\s*=\s*require("SPEC")`, in document
 * order and non-overlapping.
 *
 * THE SKIP, and why it is exact here. `[^}]+` cannot contain `}`, so for a head
 * whose brace sits at `b` the body is forced to run from `b + 1` to the FIRST
 * `}` after it — there is no other `}` the terminator could match. Every head
 * whose brace lies before that `}` therefore has the identical body END and the
 * identical tail, so when one fails they all fail: the scan resumes past the
 * brace rather than at the next start position. Two markers and two million
 * markers both cost one tail probe.
 *
 * A `}` that does not exist in the rest of the content ends the scan outright —
 * no body can close, so no later head can match either.
 */
function scanRequireDestructuring(content: string): DestructuringMatch[] {
  const matches: DestructuringMatch[] = [];
  REQUIRE_DESTRUCTURING_HEAD_PATTERN.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = REQUIRE_DESTRUCTURING_HEAD_PATTERN.exec(content)) !== null) {
    const openBrace = head.index + head[0].length - 1;
    const closeBrace = content.indexOf("}", openBrace + 1);
    if (closeBrace === -1) break;
    REQUIRE_DESTRUCTURING_TAIL_PATTERN.lastIndex = closeBrace + 1;
    const tail = REQUIRE_DESTRUCTURING_TAIL_PATTERN.exec(content);
    // No tail, or an empty body (`[^}]+` needs at least one character): resume
    // past this brace — every head sharing it fails for the same reason.
    if (!tail || closeBrace === openBrace + 1) {
      REQUIRE_DESTRUCTURING_HEAD_PATTERN.lastIndex = closeBrace + 1;
      continue;
    }
    matches.push({
      bindings: content.slice(openBrace + 1, closeBrace),
      specifier: tail[1]!,
    });
    REQUIRE_DESTRUCTURING_HEAD_PATTERN.lastIndex = tail.index + tail[0].length;
  }
  return matches;
}

function routeSignature(route: RouteEdge): string {
  return `${route.method ?? ""}\0${route.path}\0${route.handler}`;
}

/**
 * Dedupe by content signature, then sort by it. Both halves are content-derived,
 * so a shuffled input array yields byte-identical output (the extractor
 * array-order invariant). `routeSignature` covers EVERY field of `RouteEdge`, so
 * two routes sharing a signature are equal and it does not matter which survives
 * — a field added to `RouteEdge` must join the signature, or the survivor becomes
 * a function of push order again.
 */
export function uniqueSortedRoutes(routes: RouteEdge[]): RouteEdge[] {
  const deduped = new Map<string, RouteEdge>();
  for (const route of routes) {
    deduped.set(routeSignature(route), route);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      compareCodeUnits(a.path, b.path) ||
      compareCodeUnits(a.handler, b.handler) ||
      compareCodeUnits(a.method ?? "", b.method ?? ""),
  );
}

const TS_LIKE_EXTENSION_PATTERN = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Whether a decorator / registration argument is a ROUTE PATH literal at all.
 *
 * Every framework read through {@link addRouteEvidence} and the Python decorator
 * branch writes an ABSOLUTE path — `"/users"` — or the wildcard form.
 * {@link normalizeRoutePath} MANUFACTURES a leading slash, because the two
 * frameworks whose sub-paths are legitimately relative (NestJS method decorators
 * under an `@Controller` prefix, Angular route objects) need it — and that
 * manufacture is exactly what disguised non-routes as routes: `@mock.patch(
 * "os.environ")` became `/os.environ`, and prose `router.post("users", …)` became
 * `/users`. So the decision is made on the RAW literal, before normalization.
 */
function isAbsoluteRoutePathLiteral(
  literal: string | undefined,
): literal is string {
  if (literal === undefined) {
    return false;
  }
  const trimmed = literal.trim();
  return trimmed.startsWith("/") || trimmed === "*";
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (trimmed === "*" || trimmed === "/*") {
    return trimmed;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/{2,}/g, "/");
}

function normalizeHttpMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper === "DEL" ? "DELETE" : upper;
}

function isIdentifier(value: string | undefined): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export interface ImportBinding {
  target: string;
  specifier: string;
}

function addImportBinding(
  bindings: Map<string, ImportBinding>,
  localName: string | undefined,
  binding: ImportBinding,
): void {
  if (isIdentifier(localName)) {
    bindings.set(localName, binding);
  }
}

function parseNamedImportLocal(rawName: string): string | undefined {
  let i = 0;
  const len = rawName.length;

  // 1. Skip leading whitespace
  while (i < len && WHITESPACE_CHARACTER.test(rawName[i]!)) i++;

  // 2. Skip optional `type\s+`
  if (
    rawName.startsWith("type", i) &&
    i + 4 < len &&
    WHITESPACE_CHARACTER.test(rawName[i + 4]!)
  ) {
    i += 4;
    while (i < len && WHITESPACE_CHARACTER.test(rawName[i]!)) i++;
  }

  // 3. Scan first identifier
  const firstStart = i;
  while (i < len && (isWordCharacterAt(rawName, i) || rawName[i] === "$")) {
    i++;
  }
  const firstIdent = rawName.slice(firstStart, i);
  if (!isIdentifier(firstIdent)) {
    return undefined;
  }

  let localName = firstIdent;

  // 4. Scan the rest of the binding in a single pass
  while (i < len) {
    const ch = rawName[i]!;

    if (WHITESPACE_CHARACTER.test(ch)) {
      i++;
      continue;
    }

    if (ch === "=") {
      break;
    }

    if (ch === ":") {
      i++;
      while (i < len && WHITESPACE_CHARACTER.test(rawName[i]!)) i++;
      const nextStart = i;
      while (i < len && (isWordCharacterAt(rawName, i) || rawName[i] === "$")) {
        i++;
      }
      const nextIdent = rawName.slice(nextStart, i);
      if (isIdentifier(nextIdent)) {
        localName = nextIdent;
      } else {
        return undefined;
      }
      continue;
    }

    if (
      (ch === "a" || ch === "A") &&
      i + 1 < len &&
      (rawName[i + 1] === "s" || rawName[i + 1] === "S") &&
      (i + 2 >= len || WHITESPACE_CHARACTER.test(rawName[i + 2]!))
    ) {
      i += 2;
      while (i < len && WHITESPACE_CHARACTER.test(rawName[i]!)) i++;
      const aliasStart = i;
      while (i < len && (isWordCharacterAt(rawName, i) || rawName[i] === "$")) {
        i++;
      }
      const aliasIdent = rawName.slice(aliasStart, i);
      if (isIdentifier(aliasIdent)) {
        localName = aliasIdent;
      } else {
        return undefined;
      }
      continue;
    }

    i++;
  }

  return isIdentifier(localName) ? localName : undefined;
}

function addNamedImportBindings(
  bindings: Map<string, ImportBinding>,
  rawBindings: string,
  binding: ImportBinding,
): void {
  for (const rawName of rawBindings.split(",")) {
    addImportBinding(bindings, parseNamedImportLocal(rawName), binding);
  }
}

export function extractImportBindings(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const match of scanImportClauses(content)) {
    const clause = match.clause.trim();
    const specifier = match.specifier;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (!target) continue;
    const binding = { target, specifier };

    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    addImportBinding(bindings, namespaceMatch?.[1], binding);

    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch?.[1]) {
      addNamedImportBindings(bindings, namedMatch[1], binding);
    }

    const defaultCandidate = clause
      .split(/[,{]/, 1)[0]
      ?.trim()
      .replace(/^type\s+/i, "");
    addImportBinding(bindings, defaultCandidate, binding);
  }

  REQUIRE_BINDING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(REQUIRE_BINDING_PATTERN)) {
    const localName = match[1];
    const specifier = match[2];
    if (!localName || !specifier) continue;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (target) {
      addImportBinding(bindings, localName, { target, specifier });
    }
  }

  for (const match of scanRequireDestructuring(content)) {
    const target = resolveSpecifier(fromPath, match.specifier, pathLookup);
    if (target) {
      addNamedImportBindings(
        bindings,
        match.bindings,
        { target, specifier: match.specifier },
      );
    }
  }

  return bindings;
}

function importedHandlerBinding(
  handlerExpression: string,
  bindings: Map<string, ImportBinding>,
): ImportBinding | undefined {
  const rootIdentifier = handlerExpression.split(".")[0];
  return rootIdentifier ? bindings.get(rootIdentifier) : undefined;
}

function addRouteEvidence(params: {
  fromPath: string;
  routes: RouteEdge[];
  calls: GraphEdge[];
  method?: string;
  routePath: string;
  handlerExpression?: string;
  bindings: Map<string, ImportBinding>;
}): void {
  // A registration argument that is not an absolute path is not a route: the
  // `<object>.<verb>("literal", handler)` shape is common prose and common
  // non-HTTP API (COR-74363fa8's class), and only the leading slash separates
  // them mechanically.
  if (!isAbsoluteRoutePathLiteral(params.routePath)) {
    return;
  }

  const method = params.method ? normalizeHttpMethod(params.method) : undefined;
  if (method && !ROUTE_METHODS.has(method)) {
    return;
  }

  const handlerBinding = params.handlerExpression
    ? importedHandlerBinding(params.handlerExpression, params.bindings)
    : undefined;
  const handlerPath = handlerBinding?.target ?? params.fromPath;
  const route: RouteEdge = {
    path: normalizeRoutePath(params.routePath),
    handler: handlerPath,
  };
  if (method) {
    route.method = method;
  }
  params.routes.push(route);

  if (handlerBinding && handlerPath !== params.fromPath) {
    params.calls.push(
      graphEdge({
        from: params.fromPath,
        to: handlerPath,
        kind: "route-handler-link",
        confidence: ROUTE_HANDLER_EDGE_CONFIDENCE,
        reason: `Route ${method ?? "handler"} '${route.path}' passes handler '${params.handlerExpression}' from '${handlerBinding.specifier}'.`,
      }),
    );
  }
}

const COMPONENT_EXTENSION_PATTERN = /\.(?:vue|svelte|astro)$/i;

function stripHtmlComments(content: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf("<!--", cursor);
    if (open === -1) {
      result += content.slice(cursor);
      break;
    }
    result += content.slice(cursor, open);
    const close = content.indexOf("-->", open + 4);
    if (close === -1) {
      break;
    }
    cursor = close + 3;
  }
  return result;
}

function findTagEnd(content: string, fromIndex: number): number {
  let quote: string | undefined;
  for (let i = fromIndex; i < content.length; i++) {
    const char = content[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === "\\") {
        i++;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function extractScriptTags(content: string): string[] {
  const regions: string[] = [];
  const lower = content.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const scriptIndex = lower.indexOf("<script", searchFrom);
    if (scriptIndex === -1) break;

    const charAfter = lower[scriptIndex + 7];
    if (
      charAfter !== undefined &&
      charAfter !== ">" &&
      !/\s/.test(charAfter) &&
      charAfter !== "/"
    ) {
      searchFrom = scriptIndex + 7;
      continue;
    }

    const tagEnd = findTagEnd(content, scriptIndex + 7);
    if (tagEnd === -1) break;

    if (content.slice(scriptIndex, tagEnd + 1).trimEnd().endsWith("/>")) {
      searchFrom = tagEnd + 1;
      continue;
    }

    const closeIndex = lower.indexOf("</script>", tagEnd + 1);
    if (closeIndex === -1) {
      regions.push(content.slice(tagEnd + 1));
      break;
    }

    regions.push(content.slice(tagEnd + 1, closeIndex));
    searchFrom = closeIndex + 9;
  }

  return regions;
}

function extractAstroFrontmatter(content: string): string | undefined {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return undefined;

  const firstNl = trimmed.indexOf("\n");
  if (firstNl === -1) return undefined;
  const afterFirstFence = trimmed.slice(firstNl + 1);

  let searchPos = 0;
  while (searchPos < afterFirstFence.length) {
    const nextFence = afterFirstFence.indexOf("\n---", searchPos);
    if (nextFence === -1) {
      if (afterFirstFence.startsWith("---")) {
        return "";
      }
      return undefined;
    }
    const fenceEnd = nextFence + 4;
    const nextNl = afterFirstFence.indexOf("\n", fenceEnd);
    const lineRemainder = afterFirstFence
      .slice(fenceEnd, nextNl === -1 ? undefined : nextNl)
      .trim();
    if (lineRemainder === "" || lineRemainder === "\r") {
      return afterFirstFence.slice(0, nextFence);
    }
    searchPos = fenceEnd;
  }
  return undefined;
}

export function extractComponentScriptRegions(
  filePath: string,
  content: string,
): string[] {
  const normalized = filePath.toLowerCase();
  const withoutHtmlComments = stripHtmlComments(content);
  const regions: string[] = [];

  if (normalized.endsWith(".astro")) {
    const frontmatter = extractAstroFrontmatter(withoutHtmlComments);
    if (frontmatter) {
      regions.push(frontmatter);
    }
  }

  regions.push(...extractScriptTags(withoutHtmlComments));
  return regions;
}

export function extractRegisteredRouteEvidence(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): { calls: GraphEdge[]; routes: RouteEdge[] } {
  const calls: GraphEdge[] = [];
  const routes: RouteEdge[] = [];
  const normalized = normalizeGraphPath(fromPath).toLowerCase();

  let scriptContent: string;
  if (TS_LIKE_EXTENSION_PATTERN.test(normalized)) {
    scriptContent = maskCommentSpans(content, fromPath);
  } else if (COMPONENT_EXTENSION_PATTERN.test(normalized)) {
    const regions = extractComponentScriptRegions(fromPath, content);
    if (regions.length === 0) {
      return { calls, routes };
    }
    scriptContent = regions
      .map((region) => maskCommentSpans(region, "component.ts"))
      .join("\n;\n");
  } else {
    return { calls, routes };
  }

  const bindings = extractImportBindings(fromPath, scriptContent, pathLookup);

  ROUTE_REGISTRATION_PATTERN.lastIndex = 0;
  for (const match of scriptContent.matchAll(ROUTE_REGISTRATION_PATTERN)) {
    const method = match[1];
    const routePath = match[2];
    const handlerExpression = match[3];
    if (!method || !routePath) continue;
    addRouteEvidence({
      fromPath,
      routes,
      calls,
      method,
      routePath,
      handlerExpression,
      bindings,
    });
  }

  ROUTE_OBJECT_PATTERN.lastIndex = 0;
  for (const match of scriptContent.matchAll(ROUTE_OBJECT_PATTERN)) {
    const body = match[1];
    if (!body) continue;
    const method = body.match(/\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/i)?.[1];
    const routePath = body.match(/\b(?:url|path)\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1];
    const handlerExpression = body.match(
      /\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/,
    )?.[1];
    if (!routePath) continue;
    addRouteEvidence({
      fromPath,
      routes,
      calls,
      method,
      routePath,
      handlerExpression,
      bindings,
    });
  }

  return { calls, routes };
}

function stripSourceExtension(path: string): string {
  const lowerPath = path.toLowerCase();
  const extension = SOURCE_EXTENSIONS.find((item) => lowerPath.endsWith(item));
  return extension ? path.slice(0, -extension.length) : path;
}

function nextRouteSegment(segment: string): string | undefined {
  if (!segment || (segment.startsWith("(") && segment.endsWith(")"))) {
    return undefined;
  }
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll?.[1]) {
    return `:${catchAll[1]}*`;
  }
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic?.[1]) {
    return `:${dynamic[1]}`;
  }
  return segment;
}

function routePathFromSegments(segments: string[]): string | undefined {
  const routeSegments = segments
    .map(nextRouteSegment)
    .filter((segment): segment is string => segment !== undefined);
  // An empty segment list (after dropping route groups / non-path segments) is the
  // root route — e.g. App Router `app/route.ts` maps to `/`. Returning undefined
  // here would silently drop the root route.
  if (routeSegments.length === 0) {
    return normalizeRoutePath("");
  }
  return normalizeRoutePath(routeSegments.join("/"));
}

function conventionalRoutePath(filePath: string): string | undefined {
  const normalized = normalizeGraphPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const fileName = lowerParts.at(-1);
  if (!fileName) {
    return undefined;
  }

  const appIndex = lowerParts.lastIndexOf("app");
  if (appIndex >= 0 && fileName.startsWith("route.")) {
    return routePathFromSegments(parts.slice(appIndex + 1, -1));
  }

  const pagesIndex = lowerParts.lastIndexOf("pages");
  // Only look for `api` when a `pages` ancestor exists. Without a `pages` segment
  // this is not a Next.js Pages Router path, so scanning from the repo root would
  // produce false-positive API-route matches for any repo that happens to have an
  // `api/` directory (FND-COR-c86f0260).
  const apiIndex = pagesIndex >= 0 ? lowerParts.indexOf("api", pagesIndex + 1) : -1;
  if (apiIndex >= 0 && apiIndex < parts.length - 1) {
    const withoutExtension = stripSourceExtension(parts.at(-1) ?? "");
    return routePathFromSegments([...parts.slice(apiIndex, -1), withoutExtension]);
  }

  return undefined;
}

export function extractConventionalRouteEvidence(
  fromPath: string,
  content: string | undefined,
): RouteEdge[] {
  const routePath = conventionalRoutePath(fromPath);
  if (!routePath) {
    return [];
  }

  const routes: RouteEdge[] = [];
  if (content) {
    ROUTE_METHOD_EXPORT_PATTERN.lastIndex = 0;
    for (const match of content.matchAll(ROUTE_METHOD_EXPORT_PATTERN)) {
      const method = match[1];
      if (method) {
        routes.push({
          path: routePath,
          handler: fromPath,
          method,
        });
      }
    }
  }

  return routes.length > 0 ? routes : [{ path: routePath, handler: fromPath }];
}

// ---- Phase 4A: decorator / framework route detection ----
// Deterministic route patterns for NestJS, FastAPI, Flask, and Angular. These
// emit only the existing RouteEdge / route-handler-link shapes — no new
// planning-topology edge kinds. Each branch is gated on a framework marker so
// the patterns do not fire on unrelated decorators or object literals. An
// AST-based version can later move behind the analyzer seam; this is the
// regex floor for these frameworks.

const NEST_CONTROLLER_PATTERN = /@Controller\s*\(([\s\S]{0,200}?)\)/g;
const NEST_METHOD_DECORATOR_PATTERN =
  /@(Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/g;
const PY_DECORATOR_METHOD_PATTERN =
  /@\s*([A-Za-z_]\w*)\s*\.\s*(get|post|put|patch|delete|options|head|trace|websocket)\s*\(\s*["']([^"']+)["']/g;
const PY_ROUTE_DECORATOR_PATTERN =
  /@\s*([A-Za-z_]\w*)\s*\.\s*(api_route|route)\s*\(\s*["']([^"']+)["']([\s\S]{0,200}?)\)/g;
const PY_METHODS_LIST_PATTERN = /methods\s*=\s*\[([^\]]*)\]/;
const PY_METHOD_LITERAL_PATTERN = /["']([A-Za-z]+)["']/g;
/**
 * Positive Python web-framework marker — the gate the two decorator patterns
 * above run behind. `@<object>.<verb>("literal")` is not a route shape on its
 * own: the ubiquitous test idiom `@mock.patch("os.environ")` matches it exactly,
 * so scanning every `.py` file fabricated a route (and a route node) out of every
 * patched test in a repo (COR-74363fa8). A file therefore qualifies by
 * importing a web framework, by constructing one of its app/router objects, or
 * by importing a router from a sibling module.
 * Extension alone is never a marker.
 */
const PY_FRAMEWORK_MARKER_PATTERN =
  /\b(?:from|import)\s+(?:fastapi|flask|starlette|quart|sanic|litestar|falcon|bottle|tornado|aiohttp|django)\b|\b(?:FastAPI|APIRouter|Flask|Blueprint|Starlette|Quart|Sanic|Litestar)\s*\(/;

function isPythonRouterName(name: string): boolean {
  return (
    /^(?:.*_)?(?:router|app|bp|blueprint)(?:_.*)?$/i.test(name) ||
    /^(?:api|server)$/i.test(name)
  );
}

function parsePythonBindings(
  rawBindings: string,
  identities: Set<string>,
): void {
  for (const rawBinding of rawBindings.split(",")) {
    const item = rawBinding.trim();
    if (!item) continue;
    const bindingMatch = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(
      item,
    );
    if (!bindingMatch) continue;
    const importedName = bindingMatch[1]!;
    const localName = bindingMatch[2] ?? importedName;
    if (isPythonRouterName(importedName)) {
      identities.add(localName);
    }
  }
}

function resolvePythonRouterIdentities(content: string): Set<string> {
  const identities = new Set<string>();

  const PY_INSTANTIATION_PATTERN =
    /\b([A-Za-z_]\w*)\s*=\s*(?:FastAPI|APIRouter|Flask|Blueprint|Starlette|Quart|Sanic|Litestar)\s*\(/g;
  for (const match of content.matchAll(PY_INSTANTIATION_PATTERN)) {
    if (match[1]) {
      identities.add(match[1]);
    }
  }

  if (PY_FRAMEWORK_MARKER_PATTERN.test(content)) {
    identities.add("app");
    identities.add("router");
    identities.add("bp");
    identities.add("blueprint");
    identities.add("api");
    identities.add("server");
  }

  // Scan line by line for sibling imports: `from .<spec> import ...`
  const lines = content.split(/\r?\n/);
  let inSiblingImport = false;
  let collectedBindings = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSiblingImport) {
      const fromMatch = /^from\s+(\.+[\w.]*)\s+import\s*(.*)$/.exec(trimmed);
      if (fromMatch && fromMatch[1]?.startsWith(".")) {
        const rest = fromMatch[2]?.trim() ?? "";
        if (rest.startsWith("(") && !rest.includes(")")) {
          inSiblingImport = true;
          collectedBindings = rest.slice(1);
        } else {
          parsePythonBindings(rest.replace(/[()]/g, ""), identities);
        }
      }
    } else {
      if (trimmed.includes(")")) {
        inSiblingImport = false;
        const beforeParen = trimmed.slice(0, trimmed.indexOf(")"));
        collectedBindings += " " + beforeParen;
        parsePythonBindings(collectedBindings, identities);
        collectedBindings = "";
      } else {
        collectedBindings += " " + trimmed;
      }
    }
  }

  return identities;
}
const ANGULAR_FILE_MARKER_PATTERN =
  /\b(?:RouterModule|provideRouter|loadChildren|loadComponent)\b|:\s*Routes\b/;
const ANGULAR_ROUTE_OBJECT_PATTERN =
  /\{[^{}]*?\bpath\s*:\s*["'`]([^"'`]*)["'`][^{}]*?\}/g;
const ANGULAR_ROUTE_KEY_PATTERN =
  /\b(?:component|loadChildren|loadComponent|redirectTo)\s*:/;
const ANGULAR_COMPONENT_PATTERN =
  /\b(?:component|loadComponent)\s*:\s*([A-Za-z_$][\w$]*)/;
/**
 * The lazy-import target of a route object. The gap between the key and
 * `import(` is BOUNDED, and the bound is load-bearing rather than cosmetic: an
 * unbounded `[\s\S]*?` makes the pattern Θ(n²) on a file that repeats the marker
 * (`loadChildren:` × n — the family an analyzer sweep flagged at
 * `docs/reviews/analysis-tools-plan-2026-08-07.md` §4/§5, confirmed here at
 * 1.8/9.3/37.6/115.8ms across 2k/4k/8k/16k input): every start position scans the
 * rest of the file looking for an `import(` that is not there. Bounding the gap
 * makes each start O(200) and the whole scan linear. `{0,200}` is the same
 * window {@link NEST_CONTROLLER_PATTERN} and the Python decorator patterns use,
 * and is far wider than the real shape (`loadChildren: () => import('./x')`
 * spans about 20 characters).
 */
const ANGULAR_LAZY_IMPORT_PATTERN =
  /\b(?:loadChildren|loadComponent)\s*:[\s\S]{0,200}?import\s*\(\s*["']([^"']+)["']\s*\)/;

function trimRouteEdgeSlashes(segment: string): string {
  const trimmed = segment.trim();
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed.charCodeAt(start) === 47 /* '/' */) {
    start++;
  }
  while (end > start && trimmed.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return start === 0 && end === trimmed.length ? trimmed : trimmed.slice(start, end);
}

/** Join route segments (controller prefix + method path) into one clean path. */
function joinRouteSegments(...segments: string[]): string {
  return segments
    .map(trimRouteEdgeSlashes)
    .filter((segment) => segment.length > 0)
    .join("/");
}

/** Controller prefixes in document order, so each method can take the nearest. */
function nestControllerPrefixes(
  content: string,
): Array<{ index: number; prefix: string }> {
  const prefixes: Array<{ index: number; prefix: string }> = [];
  NEST_CONTROLLER_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(NEST_CONTROLLER_PATTERN)) {
    const arg = match[1] ?? "";
    const pathProp = arg.match(/\bpath\s*:\s*["'`]([^"'`]*)["'`]/);
    const firstString = arg.match(/["'`]([^"'`]*)["'`]/);
    const prefix = pathProp?.[1] ?? firstString?.[1] ?? "";
    prefixes.push({ index: match.index ?? 0, prefix });
  }
  return prefixes;
}

function collectNestRoutes(
  fromPath: string,
  content: string,
  routes: RouteEdge[],
): void {
  if (!content.includes("@Controller")) {
    return;
  }
  const controllers = nestControllerPrefixes(content);
  if (controllers.length === 0) {
    return;
  }

  NEST_METHOD_DECORATOR_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(NEST_METHOD_DECORATOR_PATTERN)) {
    const method = match[1];
    if (!method) continue;
    const subPath = match[2] ?? "";
    const at = match.index ?? 0;
    let prefix = "";
    for (const controller of controllers) {
      if (controller.index <= at) prefix = controller.prefix;
      else break;
    }
    routes.push({
      path: normalizeRoutePath(joinRouteSegments(prefix, subPath)),
      handler: fromPath,
      method: method.toUpperCase(),
    });
  }
}

function pythonRouteMethods(args: string): string[] {
  const listMatch = args.match(PY_METHODS_LIST_PATTERN);
  if (!listMatch?.[1]) return [];
  PY_METHOD_LITERAL_PATTERN.lastIndex = 0;
  return [...listMatch[1].matchAll(PY_METHOD_LITERAL_PATTERN)].map((method) =>
    method[1]!.toUpperCase(),
  );
}

export function collectPythonFrameworkRoutes(
  fromPath: string,
  content: string,
  routes: RouteEdge[],
): void {
  const maskedContent = maskCommentSpans(content, fromPath);
  const routerIdentities = resolvePythonRouterIdentities(maskedContent);
  if (routerIdentities.size === 0) {
    return;
  }

  // FastAPI / Starlette: @app.get("/x"), @router.post("/y"), @router.websocket("/ws")
  PY_DECORATOR_METHOD_PATTERN.lastIndex = 0;
  for (const match of maskedContent.matchAll(PY_DECORATOR_METHOD_PATTERN)) {
    const objectName = match[1];
    const verb = match[2];
    const routePath = match[3];
    if (!objectName || !routerIdentities.has(objectName)) continue;
    if (!verb || !isAbsoluteRoutePathLiteral(routePath)) continue;
    const method = verb.toUpperCase();
    routes.push({
      path: normalizeRoutePath(routePath),
      handler: fromPath,
      method: method === "WEBSOCKET" ? "WS" : method,
    });
  }

  // FastAPI api_route + Flask route: @app.route("/x", methods=["GET","POST"])
  PY_ROUTE_DECORATOR_PATTERN.lastIndex = 0;
  for (const match of maskedContent.matchAll(PY_ROUTE_DECORATOR_PATTERN)) {
    const objectName = match[1];
    const routePath = match[3];
    if (!objectName || !routerIdentities.has(objectName)) continue;
    if (!isAbsoluteRoutePathLiteral(routePath)) continue;
    const methods = pythonRouteMethods(match[4] ?? "");
    const path = normalizeRoutePath(routePath);
    if (methods.length === 0) {
      routes.push({ path, handler: fromPath, method: "GET" });
      continue;
    }
    for (const method of methods) {
      routes.push({ path, handler: fromPath, method });
    }
  }
}

function collectAngularRoutes(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
  calls: GraphEdge[],
  routes: RouteEdge[],
): void {
  if (!ANGULAR_FILE_MARKER_PATTERN.test(content)) {
    return;
  }
  const bindings = extractImportBindings(fromPath, content, pathLookup);

  ANGULAR_ROUTE_OBJECT_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(ANGULAR_ROUTE_OBJECT_PATTERN)) {
    const body = match[0];
    if (!ANGULAR_ROUTE_KEY_PATTERN.test(body)) {
      continue;
    }
    const routePath = normalizeRoutePath(match[1] ?? "");

    let handlerPath = fromPath;
    let handlerExpression: string | undefined;
    const lazyImport = body.match(ANGULAR_LAZY_IMPORT_PATTERN);
    const component = body.match(ANGULAR_COMPONENT_PATTERN);
    if (lazyImport?.[1]) {
      const target =
        resolveSpecifier(fromPath, lazyImport[1], pathLookup) ??
        resolveReferenceLiteral(fromPath, lazyImport[1], pathLookup);
      if (target) {
        handlerPath = target;
        handlerExpression = lazyImport[1];
      }
    } else if (component?.[1]) {
      const binding = bindings.get(component[1]);
      if (binding) {
        handlerPath = binding.target;
        handlerExpression = component[1];
      }
    }

    routes.push({ path: routePath, handler: handlerPath });
    if (handlerPath !== fromPath) {
      calls.push(
        graphEdge({
          from: fromPath,
          to: handlerPath,
          kind: "route-handler-link",
          confidence: ROUTE_HANDLER_EDGE_CONFIDENCE,
          reason: `Angular route '${routePath}' maps to '${handlerExpression ?? handlerPath}'.`,
        }),
      );
    }
  }
}

export function extractFrameworkRouteEvidence(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): { calls: GraphEdge[]; routes: RouteEdge[] } {
  const normalized = normalizeGraphPath(fromPath).toLowerCase();
  const calls: GraphEdge[] = [];
  const routes: RouteEdge[] = [];

  if (normalized.endsWith(".py")) {
    collectPythonFrameworkRoutes(fromPath, content, routes);
  } else if (
    TS_LIKE_EXTENSION_PATTERN.test(normalized) ||
    COMPONENT_EXTENSION_PATTERN.test(normalized)
  ) {
    const scriptContent = COMPONENT_EXTENSION_PATTERN.test(normalized)
      ? extractComponentScriptRegions(fromPath, content).join("\n;\n")
      : content;
    collectNestRoutes(fromPath, scriptContent, routes);
    collectAngularRoutes(fromPath, scriptContent, pathLookup, calls, routes);
  }

  return { calls, routes };
}

function isRouteSegmentName(segment: string): boolean {
  if (!segment.startsWith("route")) return false;
  let i = 5;
  if (segment.charCodeAt(i) === 115 /* 's' */) {
    i++;
  }
  if (i === segment.length) return true;
  if (segment.charCodeAt(i) === 46 /* '.' */) {
    return i + 1 < segment.length && segment.indexOf(".", i + 1) === -1;
  }
  return false;
}

export function fallbackRouteEdge(filePath: string): RouteEdge | undefined {
  const normalized = filePath.toLowerCase();
  const len = normalized.length;
  let start = 0;

  while (start < len) {
    while (start < len && normalized.charCodeAt(start) === 47 /* '/' */) {
      start++;
    }
    if (start >= len) break;
    let end = start;
    while (end < len && normalized.charCodeAt(end) !== 47 /* '/' */) {
      end++;
    }
    const segment = normalized.slice(start, end);
    const hasApi = segment === "api" && end < len;
    const hasRoute = isRouteSegmentName(segment);

    if (hasApi || hasRoute) {
      return {
        path: `/${filePath.replaceAll("/", "_")}`,
        handler: filePath,
        method: "GET",
      };
    }
    start = end + 1;
  }
  return undefined;
}
