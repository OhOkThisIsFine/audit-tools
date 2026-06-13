import { posix } from "node:path";
import type { Lens, RepoManifest } from "../types.js";
import type { FileDisposition, GraphBundle, GraphEdge, SurfaceRecord } from "@audit-tools/shared";
import { buildDispositionMap, isAuditExcludedStatus } from "./disposition.js";
import {
  graphEdge,
  normalizeGraphPath,
  resolveCandidate,
} from "./graphPathUtils.js";

export const BROWSER_EXTENSION_HEURISTIC_NOTE =
  "Chrome extension manifest and HTML asset references were resolved deterministically from local paths; verify unusual dynamic registration manually.";

const CHROME_EXTENSION_BACKGROUND_EDGE = "chrome-extension-background-link";
const CHROME_EXTENSION_CONTENT_SCRIPT_EDGE =
  "chrome-extension-content-script-link";
const CHROME_EXTENSION_CONTENT_STYLE_EDGE =
  "chrome-extension-content-style-link";
const CHROME_EXTENSION_UI_PAGE_EDGE = "chrome-extension-ui-page-link";
const CHROME_EXTENSION_WEB_ACCESSIBLE_EDGE =
  "chrome-extension-web-accessible-resource-link";
const HTML_RESOURCE_EDGE = "html-resource-link";
const CHROME_EXTENSION_EDGE_CONFIDENCE = 0.94;
const HTML_RESOURCE_EDGE_CONFIDENCE = 0.86;

const EXTENSION_SURFACE_EDGE_KINDS = new Set([
  CHROME_EXTENSION_BACKGROUND_EDGE,
  CHROME_EXTENSION_CONTENT_SCRIPT_EDGE,
  CHROME_EXTENSION_UI_PAGE_EDGE,
]);

const HIGH_RISK_PERMISSION_TOKENS = [
  "<all_urls>",
  "activeTab",
  "debugger",
  "declarativeNetRequest",
  "downloads",
  "downloads.open",
  "nativeMessaging",
  "proxy",
  "scripting",
  "tabs",
  "unlimitedStorage",
  "webNavigation",
  "webRequest",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => asString(item))
        .filter((item): item is string => item !== undefined)
    : [];
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isBrowserExtensionManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "manifest.json";
}

function isBrowserExtensionManifest(value: Record<string, unknown>): boolean {
  return (
    typeof value.manifest_version === "number" &&
    (isRecord(value.background) ||
      Array.isArray(value.content_scripts) ||
      isRecord(value.action) ||
      isRecord(value.browser_action) ||
      isRecord(value.page_action) ||
      isRecord(value.side_panel) ||
      isRecord(value.options_ui) ||
      typeof value.options_page === "string" ||
      typeof value.devtools_page === "string" ||
      isRecord(value.chrome_url_overrides) ||
      Array.isArray(value.web_accessible_resources))
  );
}

function localPathCandidate(specifier: string): string | undefined {
  const withoutQuery = specifier.trim().split(/[?#]/, 1)[0]?.trim() ?? "";
  if (
    withoutQuery.length === 0 ||
    withoutQuery.startsWith("<") ||
    withoutQuery.includes("*") ||
    /^[a-z][a-z0-9+.-]*:/i.test(withoutQuery) ||
    withoutQuery.startsWith("//")
  ) {
    return undefined;
  }

  return normalizeGraphPath(withoutQuery).replace(/^\/+/, "");
}

function resolveLocalReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const local = localPathCandidate(specifier);
  if (!local) {
    return undefined;
  }
  const isRootRelative = specifier.trim().startsWith("/");
  const baseDir = posix.dirname(normalizeGraphPath(fromPath));
  const candidate =
    isRootRelative || baseDir === "." ? local : posix.join(baseDir, local);
  return resolveCandidate(candidate, pathLookup);
}

function addManifestReference(
  edges: GraphEdge[],
  params: {
    fromPath: string;
    field: string;
    kind: string;
    specifier: string;
    pathLookup: Map<string, string>;
  },
): void {
  const target = resolveLocalReference(
    params.fromPath,
    params.specifier,
    params.pathLookup,
  );
  if (!target) {
    return;
  }
  edges.push(
    graphEdge({
      from: params.fromPath,
      to: target,
      kind: params.kind,
      confidence: CHROME_EXTENSION_EDGE_CONFIDENCE,
      reason: `Chrome extension manifest field '${params.field}' references '${params.specifier}'.`,
    }),
  );
}

function collectExtensionUiPageReferences(
  manifest: Record<string, unknown>,
): Array<{ field: string; specifier: string }> {
  const entries: Array<{ field: string; specifier: string }> = [];
  for (const objectField of ["action", "browser_action", "page_action"]) {
    const value = manifest[objectField];
    if (isRecord(value)) {
      const popup = asString(value.default_popup);
      if (popup) entries.push({ field: `${objectField}.default_popup`, specifier: popup });
    }
  }

  const sidePanel = manifest.side_panel;
  if (isRecord(sidePanel)) {
    const path = asString(sidePanel.default_path);
    if (path) entries.push({ field: "side_panel.default_path", specifier: path });
  }

  const optionsPage = asString(manifest.options_page);
  if (optionsPage) entries.push({ field: "options_page", specifier: optionsPage });

  const optionsUi = manifest.options_ui;
  if (isRecord(optionsUi)) {
    const page = asString(optionsUi.page);
    if (page) entries.push({ field: "options_ui.page", specifier: page });
  }

  const devtoolsPage = asString(manifest.devtools_page);
  if (devtoolsPage) entries.push({ field: "devtools_page", specifier: devtoolsPage });

  const overrides = manifest.chrome_url_overrides;
  if (isRecord(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      const page = asString(value);
      if (page) entries.push({ field: `chrome_url_overrides.${key}`, specifier: page });
    }
  }

  const sandbox = manifest.sandbox;
  if (isRecord(sandbox)) {
    asStringArray(sandbox.pages).forEach((page, index) =>
      entries.push({ field: `sandbox.pages.${index}`, specifier: page }),
    );
  }

  return entries;
}

function collectWebAccessibleReferences(
  manifest: Record<string, unknown>,
): Array<{ field: string; specifier: string }> {
  const entries: Array<{ field: string; specifier: string }> = [];
  const resources = manifest.web_accessible_resources;
  if (!Array.isArray(resources)) {
    return entries;
  }

  resources.forEach((item, index) => {
    if (typeof item === "string") {
      entries.push({
        field: `web_accessible_resources.${index}`,
        specifier: item,
      });
      return;
    }
    if (!isRecord(item)) {
      return;
    }
    asStringArray(item.resources).forEach((resource, resourceIndex) =>
      entries.push({
        field: `web_accessible_resources.${index}.resources.${resourceIndex}`,
        specifier: resource,
      }),
    );
  });
  return entries;
}

export function extractChromeExtensionManifestEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isBrowserExtensionManifestPath(fromPath)) {
    return [];
  }
  const manifest = parseJsonObject(content);
  if (!manifest || !isBrowserExtensionManifest(manifest)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  const background = manifest.background;
  if (isRecord(background)) {
    const serviceWorker = asString(background.service_worker);
    if (serviceWorker) {
      addManifestReference(edges, {
        fromPath,
        field: "background.service_worker",
        kind: CHROME_EXTENSION_BACKGROUND_EDGE,
        specifier: serviceWorker,
        pathLookup,
      });
    }
    asStringArray(background.scripts).forEach((script, index) =>
      addManifestReference(edges, {
        fromPath,
        field: `background.scripts.${index}`,
        kind: CHROME_EXTENSION_BACKGROUND_EDGE,
        specifier: script,
        pathLookup,
      }),
    );
  }

  const contentScripts = manifest.content_scripts;
  if (Array.isArray(contentScripts)) {
    contentScripts.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }
      asStringArray(item.js).forEach((script, scriptIndex) =>
        addManifestReference(edges, {
          fromPath,
          field: `content_scripts.${index}.js.${scriptIndex}`,
          kind: CHROME_EXTENSION_CONTENT_SCRIPT_EDGE,
          specifier: script,
          pathLookup,
        }),
      );
      asStringArray(item.css).forEach((style, styleIndex) =>
        addManifestReference(edges, {
          fromPath,
          field: `content_scripts.${index}.css.${styleIndex}`,
          kind: CHROME_EXTENSION_CONTENT_STYLE_EDGE,
          specifier: style,
          pathLookup,
        }),
      );
    });
  }

  for (const { field, specifier } of collectExtensionUiPageReferences(manifest)) {
    addManifestReference(edges, {
      fromPath,
      field,
      kind: CHROME_EXTENSION_UI_PAGE_EDGE,
      specifier,
      pathLookup,
    });
  }

  for (const { field, specifier } of collectWebAccessibleReferences(manifest)) {
    addManifestReference(edges, {
      fromPath,
      field,
      kind: CHROME_EXTENSION_WEB_ACCESSIBLE_EDGE,
      specifier,
      pathLookup,
    });
  }

  return edges;
}

// tag → the attribute that carries its resource reference. Mirrors html.ts so
// both the regex floor and the tree-sitter analyzer track the same relationships.
// Changes to which tags are tracked need only be made here and in html.ts.
const HTML_RESOURCE_ATTRIBUTE: Record<string, string> = {
  script: "src",
  link: "href",
  img: "src",
};

function extractHtmlAttributeReferences(
  content: string,
  elementName: string,
  attributeName: string,
): string[] {
  const unquotedAttributeValue = "[^\\s\"'<>`]+";
  const pattern = new RegExp(
    `<${elementName}\\b[^>]*\\b${attributeName}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|(${unquotedAttributeValue}))`,
    "gi",
  );
  const values: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) values.push(value);
  }
  return values;
}

export function extractHtmlResourceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const normalized = normalizeGraphPath(fromPath).toLowerCase();
  if (!normalized.endsWith(".html") && !normalized.endsWith(".htm")) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const [elementName, attributeName] of Object.entries(HTML_RESOURCE_ATTRIBUTE)) {
    for (const specifier of extractHtmlAttributeReferences(content, elementName, attributeName)) {
      const target = resolveLocalReference(fromPath, specifier, pathLookup);
      if (!target) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind: HTML_RESOURCE_EDGE,
          confidence: HTML_RESOURCE_EDGE_CONFIDENCE,
          reason: `HTML <${elementName} ${attributeName}> resource references '${specifier}'.`,
        }),
      );
    }
  }
  return edges;
}

export function hasBrowserExtensionManifestFile(repoManifest: RepoManifest): boolean {
  // Detect a `manifest.json` anywhere in the tree (root or a subdirectory),
  // using the same basename match as isBrowserExtensionManifestPath so the
  // repo-level gate and the per-file classifier agree.
  return repoManifest.files.some((file) =>
    isBrowserExtensionManifestPath(file.path),
  );
}

export function deriveBrowserExtensionLensesForPath(path: string): Lens[] {
  const normalized = normalizeGraphPath(path).toLowerCase();
  if (normalized === "manifest.json") {
    return ["security", "correctness", "config_deployment", "operability"];
  }
  if (
    normalized.startsWith("service/") ||
    normalized.startsWith("background/") ||
    normalized.includes("service-worker") ||
    normalized.includes("background")
  ) {
    return ["security", "correctness", "reliability", "observability"];
  }
  if (normalized.startsWith("content/") || normalized.includes("content-script")) {
    return ["security", "correctness", "reliability"];
  }
  if (
    normalized.includes("popup") ||
    normalized.includes("sidebar") ||
    normalized.includes("side-panel") ||
    normalized.includes("panel") ||
    normalized.endsWith(".html")
  ) {
    return ["security", "correctness", "maintainability"];
  }
  if (normalized.includes("worker")) {
    return ["correctness", "reliability", "performance"];
  }
  return [];
}

export function inferBrowserExtensionUnitKind(path: string): string | undefined {
  const normalized = normalizeGraphPath(path).toLowerCase();
  if (normalized === "manifest.json") return "extension_config";
  if (normalized.startsWith("service/") || normalized.startsWith("background/")) {
    return "extension_background";
  }
  if (normalized.startsWith("content/")) return "extension_content";
  if (normalized.includes("worker")) return "worker";
  if (normalized.endsWith(".html")) return "extension_ui";
  return undefined;
}

function isExecutableExtensionSurfaceTarget(path: string): boolean {
  const normalized = normalizeGraphPath(path).toLowerCase();
  return (
    normalized.endsWith(".js") ||
    normalized.endsWith(".mjs") ||
    normalized.endsWith(".cjs") ||
    normalized.endsWith(".html") ||
    normalized.endsWith(".htm")
  );
}

export function buildBrowserExtensionSurfacesFromGraph(
  graphBundle: GraphBundle | undefined,
  disposition?: FileDisposition,
): SurfaceRecord[] {
  const references = Array.isArray(graphBundle?.graphs.references)
    ? graphBundle.graphs.references
    : [];
  const dispositionMap = buildDispositionMap(disposition);
  const surfaces: SurfaceRecord[] = [];
  const seen = new Set<string>();

  for (const edge of references) {
    if (!edge.kind || !EXTENSION_SURFACE_EDGE_KINDS.has(edge.kind)) {
      continue;
    }
    if (!isExecutableExtensionSurfaceTarget(edge.to)) {
      continue;
    }
    const status = dispositionMap.get(edge.to);
    if (status && isAuditExcludedStatus(status)) {
      continue;
    }

    const kind =
      edge.kind === CHROME_EXTENSION_BACKGROUND_EDGE ? "background" : "interface";
    const key = `${kind}:${edge.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    surfaces.push({
      id: `surface:${edge.to}`,
      kind,
      entrypoint: edge.to,
      exposure:
        edge.kind === CHROME_EXTENSION_CONTENT_SCRIPT_EDGE ? "network" : "local",
      notes: [BROWSER_EXTENSION_HEURISTIC_NOTE],
    });
  }

  return surfaces.sort(
    (a, b) => a.entrypoint.localeCompare(b.entrypoint) || a.kind.localeCompare(b.kind),
  );
}

export function chromeExtensionRiskSignalsForManifest(content: string): string[] {
  const manifest = parseJsonObject(content);
  if (!manifest || !isBrowserExtensionManifest(manifest)) {
    return [];
  }
  const permissions = [
    ...asStringArray(manifest.permissions),
    ...asStringArray(manifest.optional_permissions),
    ...asStringArray(manifest.host_permissions),
  ];
  return HIGH_RISK_PERMISSION_TOKENS.filter((token) =>
    permissions.some((permission) => permission === token),
  );
}
