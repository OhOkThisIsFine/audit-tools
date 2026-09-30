// sites-pinned: tests/audit/graph-framework-routes.test.ts, tests/audit/graph-edge-cache.test.ts
import { maskCommentSpans } from "./commentDecomposition.js";
import { pythonLogicalLines, splitPythonImportList, resolvePythonModuleSpecifier } from "./graphPythonImports.js";

/** Script islands only; markup, HTML comments and data scripts are not code. */
export function routeScriptSource(path: string, content: string): string | undefined {
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)) return maskCommentSpans(content, "source.ts");
  if (!/\.(?:vue|svelte|astro)$/i.test(path)) return undefined;
  const parts: string[] = [];
  let cursor = 0;
  if (/\.astro$/i.test(path) && /^---\r?\n/.test(content)) {
    const end = /^---\s*$/gm;
    end.lastIndex = content.indexOf("\n") + 1;
    const close = end.exec(content);
    if (!close) return "";
    parts.push(content.slice(content.indexOf("\n") + 1, close.index));
    cursor = end.lastIndex;
  }
  const lower = content.toLowerCase();
  while (cursor < content.length) {
    const start = content.indexOf("<", cursor);
    if (start < 0) break;
    if (content.startsWith("<!--", start)) {
      const end = content.indexOf("-->", start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    let end = start + 1;
    let quote = "";
    for (; end < content.length; end++) {
      const char = content[end]!;
      if (quote) { if (char === quote) quote = ""; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === content.length) break;
    cursor = end + 1;
    const tag = content.slice(start + 1, end);
    const rawText = /^(style|textarea|title)(?:\s|$)/i.exec(tag);
    if (rawText) {
      const close = lower.indexOf(`</${rawText[1]!.toLowerCase()}`, cursor);
      if (close < 0) break;
      cursor = close;
      continue;
    }
    if (!/^script(?:\s|$)/i.test(tag)) continue;
    const close = lower.indexOf("</script", cursor);
    if (close < 0) break;
    const attributes = new Map<string, string>();
    for (const attr of tag.slice(6).matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      attributes.set(attr[1]!.toLowerCase(), (attr[2] ?? attr[3] ?? attr[4] ?? "").toLowerCase());
    }
    const lang = attributes.get("lang");
    const type = attributes.get("type");
    if (!attributes.has("src") && (!lang || /^(?:js|ts|javascript|typescript)$/.test(lang)) &&
      (!type || /^(?:module|text\/javascript|application\/javascript|text\/typescript)$/.test(type))) {
      parts.push(content.slice(cursor, close));
    }
    cursor = close;
  }
  return maskCommentSpans(parts.join("\n;\n"), "source.ts");
}

const FRAMEWORKS = new Set(["fastapi", "flask", "starlette", "quart", "sanic", "litestar", "falcon", "bottle", "tornado", "aiohttp", "django"]);
const CONSTRUCTORS = new Set(["FastAPI", "APIRouter", "Flask", "Blueprint", "Starlette", "Quart", "Sanic", "Litestar"]);
type Binding = { kind: "constructor" } | { kind: "router" } | { kind: "alias" | "construct"; target: string };

/** Resolve identities once, with a monotone worklist (cycles cannot invent roots). */
export function pythonRouterIdentities(files: Record<string, string>, lookup: Map<string, string>): Map<string, Set<string>> {
  const bindings = new Map<string, Binding>();
  const key = (path: string, name: string): string => `${path}\0${name}`;
  const entries = Object.entries(files).filter(([path]) => /\.py$/i.test(path) && lookup.has(path.toLowerCase()));
  for (const [path, source] of entries) {
    const content = maskCommentSpans(source, path);
    for (const line of pythonLogicalLines(content)) {
      const from = /^from\s+([.\w]+)\s+import\s+(.+)$/.exec(line);
      const plain = /^import\s+(.+)$/.exec(line);
      for (const item of splitPythonImportList(from?.[2] ?? plain?.[1] ?? "")) {
        const match = /^([.\w]+)(?:\s+as\s+(\w+))?$/.exec(item);
        if (!match) continue;
        const name = match[1]!;
        const local = match[2] ?? name;
        if (from) {
          const module = from[1]!;
          if (FRAMEWORKS.has(module.split(".")[0]!) && CONSTRUCTORS.has(name)) {
            bindings.set(key(path, local), { kind: "constructor" });
          } else {
            const submodule = resolvePythonModuleSpecifier(path, `${module}${module.endsWith(".") ? "" : "."}${name}`, lookup);
            const target = resolvePythonModuleSpecifier(path, module, lookup);
            if (submodule) bindings.set(key(path, `${local}.`), { kind: "alias", target: `${submodule}\0` });
            else if (target) bindings.set(key(path, local), { kind: "alias", target: key(target, name) });
          }
        } else if (FRAMEWORKS.has(name)) {
          for (const constructor of CONSTRUCTORS) bindings.set(key(path, `${local}.${constructor}`), { kind: "constructor" });
        } else {
          const target = resolvePythonModuleSpecifier(path, name, lookup);
          if (target) {
            // Module imports expose qualified names; resolve these on demand below.
            bindings.set(key(path, `${local}.`), { kind: "alias", target: `${target}\0` });
          }
        }
      }
    }
    for (const line of content.split(/\r?\n/)) {
      const receiver = /^[ \t]*@\s*([A-Za-z_]\w*\.[A-Za-z_]\w*)\s*\./.exec(line)?.[1];
      if (receiver) {
        const dot = receiver.indexOf(".");
        const module = bindings.get(key(path, receiver.slice(0, dot + 1)));
        if (module?.kind === "alias") bindings.set(key(path, receiver), {
          kind: "alias", target: module.target + receiver.slice(dot + 1),
        });
      }
      const assignment = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(\()?/.exec(line);
      if (assignment) bindings.set(key(path, assignment[1]!), {
        kind: assignment[3] ? "construct" : "alias", target: key(path, assignment[2]!),
      });
    }
  }
  const resolved = new Map<string, "constructor" | "router">();
  const dependents = new Map<string, Array<{ name: string; kind: "alias" | "construct" }>>();
  for (const [name, binding] of bindings) {
    if (binding.kind === "constructor" || binding.kind === "router") { resolved.set(name, binding.kind); continue; }
    let target = binding.target;
    const dot = target.lastIndexOf(".");
    if (dot > target.indexOf("\0")) {
      const module = bindings.get(target.slice(0, dot + 1));
      if (module?.kind === "alias") target = module.target + target.slice(dot + 1);
    }
    const list = dependents.get(target) ?? [];
    list.push({ name, kind: binding.kind });
    dependents.set(target, list);
  }
  const queue = [...resolved.keys()];
  for (let index = 0; index < queue.length; index++) {
    const target = queue[index]!;
    for (const dep of dependents.get(target) ?? []) {
      if (resolved.has(dep.name)) continue;
      const kind = resolved.get(target)!;
      if (dep.kind === "construct" && kind !== "constructor") continue;
      resolved.set(dep.name, dep.kind === "construct" ? "router" : kind);
      queue.push(dep.name);
    }
  }
  const result = new Map<string, Set<string>>();
  for (const [name, kind] of resolved) {
    if (kind !== "router") continue;
    const [path, local] = name.split("\0") as [string, string];
    const set = result.get(path) ?? new Set<string>();
    set.add(local);
    result.set(path, set);
  }
  return result;
}

/** Keep literal arguments readable, but never start a route match inside a string. */
export function* routeCodeMatches(content: string, pattern: RegExp): Generator<RegExpMatchArray> {
  const literals: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < content.length; index++) {
    const quote = content[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    const start = index++;
    for (; index < content.length; index++) {
      if (content[index] === "\\") index++;
      else if (content[index] === quote) break;
    }
    literals.push({ start, end: index });
  }
  let literal = 0;
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const at = match.index!;
    while (literal < literals.length && literals[literal]!.end < at) literal++;
    if (literal < literals.length && literals[literal]!.start <= at) continue;
    yield match;
  }
}
