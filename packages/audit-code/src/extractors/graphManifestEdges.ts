import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate } from "./graphPathUtils.js";

const PACKAGE_ENTRYPOINT_EDGE_CONFIDENCE = 0.9;
const PACKAGE_SCRIPT_EDGE_CONFIDENCE = 0.88;
const WORKSPACE_PACKAGE_EDGE_CONFIDENCE = 0.86;
const TYPESCRIPT_PROJECT_REFERENCE_EDGE_CONFIDENCE = 0.87;
const GO_WORKSPACE_MODULE_EDGE_CONFIDENCE = 0.87;
const CARGO_WORKSPACE_MEMBER_EDGE_CONFIDENCE = 0.87;
const MAVEN_MODULE_EDGE_CONFIDENCE = 0.87;
const PACKAGE_SCRIPT_REFERENCE_PATTERN =
  /(?:^|[\s"'`])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx))(?:$|[\s"'`])/gi;

function isPackageManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "package.json";
}

function collectPackageEntrypointValues(
  value: unknown,
  fieldPath: string,
  entries: Array<{ field: string; specifier: string }>,
): void {
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      entries.push({ field: fieldPath, specifier: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPackageEntrypointValues(item, `${fieldPath}.${index}`, entries),
    );
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    collectPackageEntrypointValues(item, `${fieldPath}.${key}`, entries);
  }
}

function packageEntrypointCandidates(
  content: string,
): Array<{ field: string; specifier: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  const entries: Array<{ field: string; specifier: string }> = [];
  for (const field of ["main", "module", "types", "typings", "browser"]) {
    collectPackageEntrypointValues(record[field], field, entries);
  }
  collectPackageEntrypointValues(record.bin, "bin", entries);
  collectPackageEntrypointValues(record.exports, "exports", entries);
  return entries;
}

function resolvePackageEntrypoint(
  packagePath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const packageDir = posix.dirname(normalizeGraphPath(packagePath));
  const packageRelative =
    packageDir === "."
      ? normalizedSpecifier
      : posix.join(packageDir, normalizedSpecifier);
  return resolveCandidate(packageRelative, pathLookup);
}

export function extractPackageEntrypointEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPackageManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const { field, specifier } of packageEntrypointCandidates(content)) {
    const target = resolvePackageEntrypoint(fromPath, specifier, pathLookup);
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "package-entrypoint-link",
        confidence: PACKAGE_ENTRYPOINT_EDGE_CONFIDENCE,
        reason: `Package manifest field '${field}' points to '${specifier}'.`,
      }),
    );
  }
  return edges;
}

function packageScriptCandidates(
  content: string,
): Array<{ script: string; specifier: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const scripts = (parsed as Record<string, unknown>).scripts;
  if (
    scripts === null ||
    typeof scripts !== "object" ||
    Array.isArray(scripts)
  ) {
    return [];
  }

  const entries: Array<{ script: string; specifier: string }> = [];
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    PACKAGE_SCRIPT_REFERENCE_PATTERN.lastIndex = 0;
    for (const match of command.matchAll(PACKAGE_SCRIPT_REFERENCE_PATTERN)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        entries.push({ script, specifier });
      }
    }
  }
  return entries;
}

export function extractPackageScriptEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPackageManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const { script, specifier } of packageScriptCandidates(content)) {
    const target = resolvePackageEntrypoint(fromPath, specifier, pathLookup);
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "package-script-link",
        confidence: PACKAGE_SCRIPT_EDGE_CONFIDENCE,
        reason: `Package script '${script}' references '${specifier}'.`,
      }),
    );
  }
  return edges;
}

interface WorkspacePattern {
  pattern: string;
  negated: boolean;
}

function addWorkspacePattern(
  patterns: WorkspacePattern[],
  rawPattern: string,
): void {
  const trimmedPattern = rawPattern.trim();
  if (trimmedPattern.length === 0) {
    return;
  }
  const negated = trimmedPattern.startsWith("!");
  const pattern = negated ? trimmedPattern.slice(1).trim() : trimmedPattern;
  if (pattern.length > 0) {
    patterns.push({ pattern, negated });
  }
}

function collectWorkspacePatternValues(
  value: unknown,
  patterns: WorkspacePattern[],
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    addWorkspacePattern(patterns, item);
  }
}

function packageWorkspacePatterns(content: string): WorkspacePattern[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  const patterns: WorkspacePattern[] = [];
  collectWorkspacePatternValues(record.workspaces, patterns);
  if (
    record.workspaces !== null &&
    typeof record.workspaces === "object" &&
    !Array.isArray(record.workspaces)
  ) {
    collectWorkspacePatternValues(
      (record.workspaces as Record<string, unknown>).packages,
      patterns,
    );
  }
  return patterns;
}

function isPnpmWorkspaceManifestPath(path: string): boolean {
  return (
    posix.basename(normalizeGraphPath(path)).toLowerCase() ===
    "pnpm-workspace.yaml"
  );
}

export function isGoWorkspaceManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "go.work";
}

function isGoModuleManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "go.mod";
}

export function isCargoManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "cargo.toml";
}

export function isMavenPomPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "pom.xml";
}

function isTypescriptProjectConfigPath(path: string): boolean {
  const basename = posix.basename(normalizeGraphPath(path)).toLowerCase();
  return (
    basename === "tsconfig.json" ||
    (basename.startsWith("tsconfig.") && basename.endsWith(".json"))
  );
}

function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        index++;
      }
      if (index < content.length) {
        result += content[index];
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") {
          result += "\n";
        }
        index++;
      }
      if (index < content.length) {
        index++;
      }
      continue;
    }

    result += char;
  }

  return result;
}

function removeTrailingJsonCommas(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(content[lookahead] ?? "")) {
        lookahead++;
      }
      if (content[lookahead] === "}" || content[lookahead] === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function parseJsoncObject(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(removeTrailingJsonCommas(stripJsonComments(content)));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitYamlInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }

  const values: string[] = [];
  let quote: '"' | "'" | undefined;
  let start = 1;
  for (let index = 1; index < trimmed.length - 1; index++) {
    const char = trimmed[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      values.push(unquoteYamlScalar(trimmed.slice(start, index)));
      start = index + 1;
    }
  }
  values.push(unquoteYamlScalar(trimmed.slice(start, -1)));
  return values.filter((item) => item.length > 0);
}

function pnpmWorkspacePatterns(content: string): WorkspacePattern[] {
  const patterns: WorkspacePattern[] = [];
  const lines = content.split(/\r?\n/);
  let inPackagesList = false;
  let packagesIndent = 0;

  for (const line of lines) {
    const withoutComment = stripYamlComment(line);
    if (withoutComment.trim().length === 0) {
      continue;
    }

    const indent = withoutComment.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = withoutComment.trim();
    if (inPackagesList) {
      if (indent <= packagesIndent) {
        inPackagesList = false;
      } else {
        const itemMatch = /^-\s+(.+)$/.exec(trimmed);
        if (itemMatch?.[1]) {
          addWorkspacePattern(patterns, unquoteYamlScalar(itemMatch[1]));
        }
        continue;
      }
    }

    const packagesMatch = /^packages\s*:\s*(.*)$/.exec(trimmed);
    if (!packagesMatch || indent !== 0) {
      continue;
    }

    const inlineValue = packagesMatch[1]?.trim() ?? "";
    if (inlineValue.length === 0) {
      inPackagesList = true;
      packagesIndent = indent;
      continue;
    }

    for (const pattern of splitYamlInlineList(inlineValue)) {
      addWorkspacePattern(patterns, pattern);
    }
  }

  return patterns;
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function tomlArrayIsClosed(value: string): boolean {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let depth = 0;

  for (const char of value) {
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth <= 0) {
        return true;
      }
    }
  }

  return false;
}

function unquoteTomlString(value: string, quote: '"' | "'"): string {
  if (quote === "'") {
    return value.trim();
  }

  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return typeof parsed === "string" ? parsed.trim() : value.trim();
  } catch {
    return value.replace(/\\"/g, "\"").trim();
  }
}

function tomlStringArrayValues(value: string): string[] {
  const values: string[] = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let start = 0;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        const item = unquoteTomlString(value.slice(start, index), quote);
        if (item.length > 0) {
          values.push(item);
        }
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      start = index + 1;
    }
  }

  return values;
}

function cargoWorkspacePatterns(content: string): WorkspacePattern[] {
  const patterns: WorkspacePattern[] = [];
  let currentSection: string | undefined;
  let collectingKey: "members" | "exclude" | undefined;
  let collectedValue = "";

  const flushCollectedValue = (): void => {
    if (!collectingKey) {
      return;
    }
    for (const value of tomlStringArrayValues(collectedValue)) {
      addWorkspacePattern(
        patterns,
        collectingKey === "exclude" ? `!${value}` : value,
      );
    }
    collectingKey = undefined;
    collectedValue = "";
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripTomlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sectionMatch?.[1]) {
      if (collectingKey) {
        flushCollectedValue();
      }
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (collectingKey) {
      collectedValue = `${collectedValue}\n${trimmed}`;
      if (tomlArrayIsClosed(collectedValue)) {
        flushCollectedValue();
      }
      continue;
    }

    if (currentSection !== "workspace") {
      continue;
    }

    const arrayMatch = /^(members|exclude)\s*=\s*(.+)$/.exec(trimmed);
    if (!arrayMatch?.[1] || !arrayMatch[2]) {
      continue;
    }

    const value = arrayMatch[2].trim();
    if (!value.startsWith("[")) {
      continue;
    }

    collectingKey = arrayMatch[1] as "members" | "exclude";
    collectedValue = value;
    if (tomlArrayIsClosed(collectedValue)) {
      flushCollectedValue();
    }
  }

  if (collectingKey) {
    flushCollectedValue();
  }

  return patterns;
}

function workspacePatternsForFile(
  path: string,
  content: string,
): WorkspacePattern[] {
  if (isPackageManifestPath(path)) {
    return packageWorkspacePatterns(content);
  }
  if (isPnpmWorkspaceManifestPath(path)) {
    return pnpmWorkspacePatterns(content);
  }
  return [];
}

function normalizeWorkspacePattern(
  workspacePath: string,
  pattern: string,
): string | undefined {
  const normalizedPattern = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalizedPattern.length === 0 ||
    normalizedPattern.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedPattern)
  ) {
    return undefined;
  }

  const workspaceDir = posix.dirname(normalizeGraphPath(workspacePath));
  return workspaceDir === "."
    ? normalizedPattern
    : posix.join(workspaceDir, normalizedPattern);
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

function workspacePatternMatchesPackage(
  workspacePattern: string,
  packagePath: string,
): boolean {
  return workspacePatternMatchesManifest(
    workspacePattern,
    packagePath,
    "package.json",
  );
}

function workspacePatternMatchesManifest(
  workspacePattern: string,
  manifestPath: string,
  manifestName: string,
): boolean {
  const normalizedManifestPath = normalizeGraphPath(manifestPath);
  const manifestDir = posix.dirname(normalizedManifestPath);
  const lowerManifestPattern = `/${manifestName.toLowerCase()}`;
  const patternTarget = workspacePattern.toLowerCase().endsWith(lowerManifestPattern)
    ? normalizedManifestPath
    : manifestDir;
  return globPatternToRegExp(workspacePattern).test(patternTarget);
}

export function extractWorkspacePackageEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const rawPatterns = workspacePatternsForFile(fromPath, content);
  if (rawPatterns.length === 0) {
    return [];
  }

  const positivePatterns: string[] = [];
  const negativePatterns: string[] = [];
  for (const { pattern, negated } of rawPatterns) {
    const normalized = normalizeWorkspacePattern(fromPath, pattern);
    if (!normalized) {
      continue;
    }
    if (negated) {
      negativePatterns.push(normalized);
    } else {
      positivePatterns.push(normalized);
    }
  }

  const edges: GraphEdge[] = [];
  for (const pattern of positivePatterns) {
    for (const target of pathLookup.values()) {
      if (target === fromPath || !isPackageManifestPath(target)) {
        continue;
      }
      if (!workspacePatternMatchesPackage(pattern, target)) {
        continue;
      }
      if (
        negativePatterns.some((negativePattern) =>
          workspacePatternMatchesPackage(negativePattern, target),
        )
      ) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind: "workspace-package-link",
          confidence: WORKSPACE_PACKAGE_EDGE_CONFIDENCE,
          reason: `Workspace pattern '${pattern}' includes package manifest '${target}'.`,
        }),
      );
    }
  }
  return edges;
}

export function extractCargoWorkspaceMemberEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isCargoManifestPath(fromPath)) {
    return [];
  }

  const rawPatterns = cargoWorkspacePatterns(content);
  if (rawPatterns.length === 0) {
    return [];
  }

  const positivePatterns: string[] = [];
  const negativePatterns: string[] = [];
  for (const { pattern, negated } of rawPatterns) {
    const normalized = normalizeWorkspacePattern(fromPath, pattern);
    if (!normalized) {
      continue;
    }
    if (negated) {
      negativePatterns.push(normalized);
    } else {
      positivePatterns.push(normalized);
    }
  }

  const edges: GraphEdge[] = [];
  for (const pattern of positivePatterns) {
    for (const target of pathLookup.values()) {
      if (target === fromPath || !isCargoManifestPath(target)) {
        continue;
      }
      if (!workspacePatternMatchesManifest(pattern, target, "Cargo.toml")) {
        continue;
      }
      if (
        negativePatterns.some((negativePattern) =>
          workspacePatternMatchesManifest(negativePattern, target, "Cargo.toml"),
        )
      ) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind: "cargo-workspace-member-link",
          confidence: CARGO_WORKSPACE_MEMBER_EDGE_CONFIDENCE,
          reason: `Cargo workspace pattern '${pattern}' includes member manifest '${target}'.`,
        }),
      );
    }
  }
  return edges;
}

function typescriptProjectReferenceSpecifiers(content: string): string[] {
  const parsed = parseJsoncObject(content);
  if (!parsed || !Array.isArray(parsed.references)) {
    return [];
  }

  return parsed.references
    .map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const referencePath = (item as Record<string, unknown>).path;
      return typeof referencePath === "string" ? referencePath.trim() : undefined;
    })
    .filter((specifier): specifier is string => Boolean(specifier));
}

function resolveTypescriptProjectReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const configDir = posix.dirname(normalizeGraphPath(fromPath));
  const target =
    configDir === "."
      ? normalizedSpecifier
      : posix.join(configDir, normalizedSpecifier);
  const direct = resolveCandidate(target, pathLookup);
  if (direct && isTypescriptProjectConfigPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(target, "tsconfig.json").toLowerCase());
}

export function extractTypescriptProjectReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isTypescriptProjectConfigPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of typescriptProjectReferenceSpecifiers(content)) {
    const target = resolveTypescriptProjectReference(
      fromPath,
      specifier,
      pathLookup,
    );
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "typescript-project-reference-link",
        confidence: TYPESCRIPT_PROJECT_REFERENCE_EDGE_CONFIDENCE,
        reason: `TypeScript project reference '${specifier}' resolves to '${target}'.`,
      }),
    );
  }
  return edges;
}

function stripGoLineComment(line: string): string {
  let quote: '"' | "`" | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];

    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "/" && next === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

function unquoteGoWorkspaceSpecifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  if (trimmed[0] === '"' && trimmed.at(-1) === '"') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed.trim() : trimmed;
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }

  if (trimmed[0] === "`" && trimmed.at(-1) === "`") {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

function splitGoWorkspaceSpecifiers(value: string): string[] {
  const specifiers: string[] = [];
  let quote: '"' | "`" | undefined;
  let escaped = false;
  let start: number | undefined;

  for (let index = 0; index <= value.length; index++) {
    const char = value[index] ?? " ";

    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "`") {
      quote = char;
      start ??= index;
      continue;
    }

    if (/\s/.test(char)) {
      if (start !== undefined) {
        const specifier = unquoteGoWorkspaceSpecifier(value.slice(start, index));
        if (specifier.length > 0) {
          specifiers.push(specifier);
        }
        start = undefined;
      }
      continue;
    }

    start ??= index;
  }

  return specifiers;
}

function goWorkspaceUseSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let inUseBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = stripGoLineComment(rawLine).trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (inUseBlock) {
      const closeIndex = trimmed.indexOf(")");
      const body =
        closeIndex >= 0 ? trimmed.slice(0, closeIndex).trim() : trimmed;
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      if (closeIndex >= 0) {
        inUseBlock = false;
      }
      continue;
    }

    const useMatch = /^use(?:\s+(.+)|\s*)$/.exec(trimmed);
    if (!useMatch) {
      continue;
    }

    let body = useMatch[1]?.trim() ?? "";
    if (!body.startsWith("(")) {
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      continue;
    }

    body = body.slice(1).trim();
    const closeIndex = body.indexOf(")");
    if (closeIndex >= 0) {
      specifiers.push(
        ...splitGoWorkspaceSpecifiers(body.slice(0, closeIndex).trim()),
      );
    } else {
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      inUseBlock = true;
    }
  }

  return specifiers;
}

function resolveGoWorkspaceModuleReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const workspaceDir = posix.dirname(normalizeGraphPath(fromPath));
  const target =
    workspaceDir === "."
      ? normalizedSpecifier
      : posix.join(workspaceDir, normalizedSpecifier);
  const direct = pathLookup.get(target.toLowerCase());
  if (direct && isGoModuleManifestPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(target, "go.mod").toLowerCase());
}

export function extractGoWorkspaceModuleEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isGoWorkspaceManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of goWorkspaceUseSpecifiers(content)) {
    const target = resolveGoWorkspaceModuleReference(
      fromPath,
      specifier,
      pathLookup,
    );
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "go-workspace-module-link",
        confidence: GO_WORKSPACE_MODULE_EDGE_CONFIDENCE,
        reason: `Go workspace use directive '${specifier}' resolves to module '${target}'.`,
      }),
    );
  }
  return edges;
}

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mavenModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const withoutComments = stripXmlComments(content);
  const modulesPattern = /<modules(?:\s[^>]*)?>([\s\S]*?)<\/modules>/gi;
  let modulesMatch: RegExpExecArray | null;

  while ((modulesMatch = modulesPattern.exec(withoutComments))) {
    const body = modulesMatch[1] ?? "";
    const modulePattern = /<module(?:\s[^>]*)?>([\s\S]*?)<\/module>/gi;
    let moduleMatch: RegExpExecArray | null;
    while ((moduleMatch = modulePattern.exec(body))) {
      const specifier = decodeXmlText(moduleMatch[1] ?? "").trim();
      if (specifier.length > 0) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function resolveMavenModuleReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const manifestDir = posix.dirname(normalizeGraphPath(fromPath));
  const target =
    manifestDir === "."
      ? normalizedSpecifier
      : posix.join(manifestDir, normalizedSpecifier);
  const normalizedTarget = normalizeGraphPath(target);
  if (normalizedTarget === ".." || normalizedTarget.startsWith("../")) {
    return undefined;
  }

  const direct = pathLookup.get(normalizedTarget.toLowerCase());
  if (direct && isMavenPomPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(normalizedTarget, "pom.xml").toLowerCase());
}

export function extractMavenModuleEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isMavenPomPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of mavenModuleSpecifiers(content)) {
    const target = resolveMavenModuleReference(fromPath, specifier, pathLookup);
    if (!target || target === fromPath) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "maven-module-link",
        confidence: MAVEN_MODULE_EDGE_CONFIDENCE,
        reason: `Maven module '${specifier}' resolves to module manifest '${target}'.`,
      }),
    );
  }
  return edges;
}

// ─── Pyproject / pytest ───────────────────────────────────────────────────────

const PYPROJECT_TESTPATHS_LINK_CONFIDENCE = 0.85;

export function isPyprojectPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "pyproject.toml";
}

function pyprojectTestpaths(content: string): string[] {
  const values: string[] = [];
  let currentSection = "";
  let collectingKey: string | undefined;
  let collectedValue = "";

  const flush = (): void => {
    if (!collectingKey) return;
    for (const v of tomlStringArrayValues(collectedValue)) {
      values.push(v);
    }
    collectingKey = undefined;
    collectedValue = "";
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripTomlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const sectionMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sectionMatch?.[1]) {
      flush();
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (collectingKey) {
      collectedValue = `${collectedValue}\n${trimmed}`;
      if (tomlArrayIsClosed(collectedValue)) {
        flush();
      }
      continue;
    }

    if (currentSection !== "tool.pytest.ini_options") continue;

    const keyMatch = /^testpaths\s*=\s*(.+)$/.exec(trimmed);
    if (!keyMatch?.[1]) continue;

    const value = keyMatch[1].trim();
    if (!value.startsWith("[")) {
      const bare = value.replace(/^["']|["']$/g, "").trim();
      if (bare.length > 0) values.push(bare);
      continue;
    }

    collectingKey = "testpaths";
    collectedValue = value;
    if (tomlArrayIsClosed(collectedValue)) {
      flush();
    }
  }

  flush();
  return values;
}

export function extractPyprojectTestpathLinks(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPyprojectPath(fromPath)) {
    return [];
  }

  const testpaths = pyprojectTestpaths(content);
  if (testpaths.length === 0) {
    return [];
  }

  const pyprojectDir = posix.dirname(normalizeGraphPath(fromPath));
  const edges: GraphEdge[] = [];

  for (const testpath of testpaths) {
    const resolvedTestpath =
      pyprojectDir === "." ? testpath : posix.join(pyprojectDir, testpath);
    const conftestKey = posix.join(resolvedTestpath, "conftest.py").toLowerCase();
    const conftestTarget = pathLookup.get(conftestKey);
    if (!conftestTarget || conftestTarget === fromPath) continue;

    edges.push(
      graphEdge({
        from: fromPath,
        to: conftestTarget,
        kind: "pyproject-testpaths-link",
        confidence: PYPROJECT_TESTPATHS_LINK_CONFIDENCE,
        reason: `pyproject.toml testpaths entry '${testpath}' resolves to '${conftestTarget}'.`,
      }),
    );
  }

  return edges;
}

// ─── YAML path references ─────────────────────────────────────────────────────

const YAML_PATH_REFERENCE_LINK_CONFIDENCE = 0.8;
const YAML_CONFIG_EXTENSIONS = [".yaml", ".yml", ".json", ".toml"] as const;

function isYamlSourcePath(path: string): boolean {
  const lower = normalizeGraphPath(path).toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

function looksLikeConfigFilePath(value: string): boolean {
  if (!value.includes("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith("/")) return false;
  const lower = value.toLowerCase();
  return YAML_CONFIG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function extractYamlScalarValues(content: string): string[] {
  const values: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    let rawValue: string | undefined;

    // key: value
    const keyValueMatch = /^[^:[\]{}]+:\s+(.+)$/.exec(trimmed);
    if (keyValueMatch?.[1]) {
      rawValue = keyValueMatch[1].trim();
    } else {
      // - value (list item)
      const listItemMatch = /^-\s+(.+)$/.exec(trimmed);
      if (listItemMatch?.[1]) {
        rawValue = listItemMatch[1].trim();
      }
    }

    if (!rawValue) continue;
    const value = unquoteYamlScalar(rawValue);
    if (looksLikeConfigFilePath(value)) {
      values.push(value);
    }
  }
  return values;
}

function resolveYamlPathReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalized = normalizeGraphPath(specifier.replace(/^\.\//, ""));
  if (normalized.length === 0) return undefined;

  // Try as repo-root-relative first (many YAML configs use repo-root paths)
  const repoRootTarget = resolveCandidate(normalized, pathLookup);
  if (repoRootTarget) return repoRootTarget;

  // Fallback: relative to the YAML file's directory
  const fromDir = posix.dirname(normalizeGraphPath(fromPath));
  if (fromDir !== ".") {
    const dirRelative = posix.join(fromDir, normalized);
    const dirTarget = resolveCandidate(dirRelative, pathLookup);
    if (dirTarget) return dirTarget;
  }

  return undefined;
}

export function extractYamlPathReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isYamlSourcePath(fromPath)) return [];

  const values = extractYamlScalarValues(content);
  if (values.length === 0) return [];

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const target = resolveYamlPathReference(fromPath, value, pathLookup);
    if (!target || target === fromPath || seen.has(target)) continue;
    seen.add(target);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "yaml-path-reference-link",
        confidence: YAML_PATH_REFERENCE_LINK_CONFIDENCE,
        reason: `YAML file references path '${value}'.`,
      }),
    );
  }
  return edges;
}
