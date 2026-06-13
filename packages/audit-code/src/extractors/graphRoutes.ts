import type { GraphEdge, RouteEdge } from "@audit-tools/shared";
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
const IMPORT_BINDING_PATTERN =
  /\bimport\s+(?:type\s+)?([^;"'](?:[^;]*?))\s+from\s+["']([^"']+)["']/g;
const REQUIRE_BINDING_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_DESTRUCTURING_PATTERN =
  /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

function routeSignature(route: RouteEdge): string {
  return `${route.method ?? ""}\0${route.path}\0${route.handler}`;
}

export function uniqueSortedRoutes(routes: RouteEdge[]): RouteEdge[] {
  const deduped = new Map<string, RouteEdge>();
  for (const route of routes) {
    deduped.set(routeSignature(route), route);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.handler.localeCompare(b.handler) ||
      (a.method ?? "").localeCompare(b.method ?? ""),
  );
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

interface ImportBinding {
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
  const normalized = rawName.trim().replace(/^type\s+/i, "").trim();
  if (!normalized) {
    return undefined;
  }
  const [, aliasedName] = normalized.split(/\s+as\s+/i);
  const localName = (aliasedName ?? normalized.split(/\s*:\s*/).at(-1) ?? "")
    .trim()
    .replace(/=.*$/, "")
    .trim();
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

function extractImportBindings(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  IMPORT_BINDING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(IMPORT_BINDING_PATTERN)) {
    const clause = match[1]?.trim();
    const specifier = match[2];
    if (!clause || !specifier) continue;
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

  REQUIRE_DESTRUCTURING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(REQUIRE_DESTRUCTURING_PATTERN)) {
    const rawBindings = match[1];
    const specifier = match[2];
    if (!rawBindings || !specifier) continue;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (target) {
      addNamedImportBindings(bindings, rawBindings, { target, specifier });
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

export function extractRegisteredRouteEvidence(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): { calls: GraphEdge[]; routes: RouteEdge[] } {
  const bindings = extractImportBindings(fromPath, content, pathLookup);
  const calls: GraphEdge[] = [];
  const routes: RouteEdge[] = [];

  ROUTE_REGISTRATION_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(ROUTE_REGISTRATION_PATTERN)) {
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
  for (const match of content.matchAll(ROUTE_OBJECT_PATTERN)) {
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
  if (routeSegments.length === 0) {
    return undefined;
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
  /@\s*[A-Za-z_]\w*\s*\.\s*(get|post|put|patch|delete|options|head|trace|websocket)\s*\(\s*["']([^"']+)["']/g;
const PY_ROUTE_DECORATOR_PATTERN =
  /@\s*[A-Za-z_]\w*\s*\.\s*(api_route|route)\s*\(\s*["']([^"']+)["']([\s\S]{0,200}?)\)/g;
const PY_METHODS_LIST_PATTERN = /methods\s*=\s*\[([^\]]*)\]/;
const PY_METHOD_LITERAL_PATTERN = /["']([A-Za-z]+)["']/g;
const ANGULAR_FILE_MARKER_PATTERN =
  /\b(?:RouterModule|provideRouter|loadChildren|loadComponent)\b|:\s*Routes\b/;
const ANGULAR_ROUTE_OBJECT_PATTERN =
  /\{[^{}]*?\bpath\s*:\s*["'`]([^"'`]*)["'`][^{}]*?\}/g;
const ANGULAR_ROUTE_KEY_PATTERN =
  /\b(?:component|loadChildren|loadComponent|redirectTo)\s*:/;
const ANGULAR_COMPONENT_PATTERN =
  /\b(?:component|loadComponent)\s*:\s*([A-Za-z_$][\w$]*)/;
const ANGULAR_LAZY_IMPORT_PATTERN =
  /\b(?:loadChildren|loadComponent)\s*:[\s\S]*?import\s*\(\s*["']([^"']+)["']\s*\)/;
const TS_LIKE_EXTENSION_PATTERN = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Join route segments (controller prefix + method path) into one clean path. */
function joinRouteSegments(...segments: string[]): string {
  return segments
    .map((segment) => segment.trim().replace(/^\/+|\/+$/g, ""))
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

function collectPythonFrameworkRoutes(
  fromPath: string,
  content: string,
  routes: RouteEdge[],
): void {
  // FastAPI / Starlette: @app.get("/x"), @router.post("/y"), @router.websocket("/ws")
  PY_DECORATOR_METHOD_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(PY_DECORATOR_METHOD_PATTERN)) {
    const verb = match[1];
    const routePath = match[2];
    if (!verb || !routePath) continue;
    const method = verb.toUpperCase();
    routes.push({
      path: normalizeRoutePath(routePath),
      handler: fromPath,
      method: method === "WEBSOCKET" ? "WS" : method,
    });
  }

  // FastAPI api_route + Flask route: @app.route("/x", methods=["GET","POST"])
  PY_ROUTE_DECORATOR_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(PY_ROUTE_DECORATOR_PATTERN)) {
    const routePath = match[2];
    if (!routePath) continue;
    const methods = pythonRouteMethods(match[3] ?? "");
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
  } else if (TS_LIKE_EXTENSION_PATTERN.test(normalized)) {
    collectNestRoutes(fromPath, content, routes);
    collectAngularRoutes(fromPath, content, pathLookup, calls, routes);
  }

  return { calls, routes };
}

export function fallbackRouteEdge(filePath: string): RouteEdge | undefined {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("api/") || normalized.includes("route")) {
    return {
      path: `/${filePath.replaceAll("/", "_")}`,
      handler: filePath,
      method: "GET",
    };
  }
  return undefined;
}
