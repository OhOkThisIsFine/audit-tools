import { test, expect } from "vitest";
import { buildGraphBundle } from "../../src/audit/extractors/graph.js";
import {
  extractConventionalRouteEvidence,
  extractFrameworkRouteEvidence,
  extractRegisteredRouteEvidence,
  fallbackRouteEdge,
  uniqueSortedRoutes,
} from "../../src/audit/extractors/graphRoutes.js";
import type { RepoManifest } from "../../src/audit/types.js";
import type { GraphBundle, RouteEdge } from "audit-tools/shared";

function manifest(paths: string[]): RepoManifest {
  return {
    repository: { name: "test-repo" },
    generated_at: new Date().toISOString(),
    files: paths.map((path) => ({
      path,
      size_bytes: 256,
      language: path.endsWith(".py") ? "python" : "typescript",
      excluded: false,
    })),
  };
}

function bundleFor(files: Record<string, string>): GraphBundle {
  return buildGraphBundle(manifest(Object.keys(files)), undefined, {
    fileContents: files,
  });
}

function routesOf(files: Record<string, string>): RouteEdge[] {
  return (bundleFor(files).graphs ?? {}).routes ?? [];
}

function hasRoute(routes: RouteEdge[], method: string, path: string, handler: string): boolean {
  return routes.some(
    (route) =>
      route.method === method &&
      route.path === path &&
      route.handler === handler,
  );
}

test("NestJS @Controller + method decorators combine prefix and sub-path", () => {
  const file = "src/cats/cats.controller.ts";
  const routes = routesOf({
    [file]: [
      "import { Controller, Get, Post } from '@nestjs/common';",
      "@Controller('cats')",
      "export class CatsController {",
      "  @Get()",
      "  findAll() {}",
      "  @Get(':id')",
      "  findOne() {}",
      "  @Post()",
      "  create() {}",
      "}",
    ].join("\n"),
  });

  expect(hasRoute(routes, "GET", "/cats", file), "GET /cats").toBeTruthy();
  expect(hasRoute(routes, "GET", "/cats/:id", file), "GET /cats/:id").toBeTruthy();
  expect(hasRoute(routes, "POST", "/cats", file), "POST /cats").toBeTruthy();
});

test("NestJS @Controller({ path }) object form resolves the prefix", () => {
  const file = "src/auth/auth.controller.ts";
  const routes = routesOf({
    [file]: [
      "@Controller({ path: 'auth' })",
      "export class AuthController {",
      "  @Post('login')",
      "  login() {}",
      "}",
    ].join("\n"),
  });
  expect(hasRoute(routes, "POST", "/auth/login", file)).toBeTruthy();
});

// TST-10b463bb: multiple @Controller decorators in the same file — each method
// must use the prefix of the nearest preceding @Controller (document-order walk).
test("NestJS multiple @Controller decorators in one file assign prefix by document order", () => {
  const file = "src/multi.controller.ts";
  const routes = routesOf({
    [file]: [
      "import { Controller, Get, Post } from '@nestjs/common';",
      "@Controller('cats')",
      "export class CatsController {",
      "  @Get()",
      "  findAll() {}",
      "}",
      "@Controller('dogs')",
      "export class DogsController {",
      "  @Get(':id')",
      "  findOne() {}",
      "  @Post()",
      "  create() {}",
      "}",
    ].join("\n"),
  });

  expect(hasRoute(routes, "GET", "/cats", file), "GET /cats from first controller").toBeTruthy();
  expect(hasRoute(routes, "GET", "/dogs/:id", file), "GET /dogs/:id from second controller").toBeTruthy();
  expect(hasRoute(routes, "POST", "/dogs", file), "POST /dogs from second controller").toBeTruthy();
  // The cats controller's GET must NOT pick up the dogs prefix
  expect(!hasRoute(routes, "GET", "/dogs", file), "GET /dogs must not exist (cats has no prefix '/dogs')").toBeTruthy();
});

test("NestJS @Controller with no argument (empty prefix) yields bare-path routes", () => {
  const file = "src/root.controller.ts";
  const routes = routesOf({
    [file]: [
      "@Controller()",
      "export class RootController {",
      "  @Get('health')",
      "  health() {}",
      "}",
    ].join("\n"),
  });

  expect(hasRoute(routes, "GET", "/health", file), "GET /health — empty prefix leaves sub-path bare").toBeTruthy();
});

test("FastAPI decorator routes map method + path to the handler file", () => {
  const file = "service/views.py";
  const routes = routesOf({
    [file]: [
      "from fastapi import FastAPI, APIRouter",
      "app = FastAPI()",
      "router = APIRouter()",
      '@app.get("/items/{item_id}")',
      "def read_item(item_id: int):",
      "    return item_id",
      '@app.post("/items")',
      "def create_item():",
      "    return None",
      '@router.websocket("/ws")',
      "async def ws():",
      "    return None",
    ].join("\n"),
  });

  expect(hasRoute(routes, "GET", "/items/{item_id}", file)).toBeTruthy();
  expect(hasRoute(routes, "POST", "/items", file)).toBeTruthy();
  expect(hasRoute(routes, "WS", "/ws", file), "websocket maps to method WS").toBeTruthy();
});

test("Flask @route with methods expands to one route per method", () => {
  const file = "webapp/views.py";
  const routes = routesOf({
    [file]: [
      'from flask import Blueprint',
      'bp = Blueprint("bp", __name__)',
      '@app.route("/login", methods=["GET", "POST"])',
      "def login():",
      "    return None",
      '@bp.route("/health")',
      "def health():",
      "    return None",
    ].join("\n"),
  });

  expect(hasRoute(routes, "GET", "/login", file)).toBeTruthy();
  expect(hasRoute(routes, "POST", "/login", file)).toBeTruthy();
  expect(hasRoute(routes, "GET", "/health", file), "no methods defaults to GET").toBeTruthy();
});

test("Angular route config resolves component to a route-handler-link", () => {
  const moduleFile = "src/app/app-routing.module.ts";
  const heroes = "src/app/heroes/heroes.component.ts";
  const dashboard = "src/app/dashboard/dashboard.component.ts";
  const bundle = bundleFor({
    [moduleFile]: [
      "import { NgModule } from '@angular/core';",
      "import { RouterModule, Routes } from '@angular/router';",
      "import { HeroesComponent } from './heroes/heroes.component';",
      "import { DashboardComponent } from './dashboard/dashboard.component';",
      "const routes: Routes = [",
      "  { path: 'heroes', component: HeroesComponent },",
      "  { path: 'dashboard', component: DashboardComponent },",
      "  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },",
      "];",
      "@NgModule({ imports: [RouterModule.forRoot(routes)], exports: [RouterModule] })",
      "export class AppRoutingModule {}",
    ].join("\n"),
    [heroes]: "export class HeroesComponent {}\n",
    [dashboard]: "export class DashboardComponent {}\n",
  });

  const routes = bundle.graphs.routes ?? [];
  expect(routes.some((r) => r.path === "/heroes" && r.handler === heroes), "heroes route resolves to its component file").toBeTruthy();
  expect(routes.some((r) => r.path === "/dashboard" && r.handler === dashboard), "dashboard route resolves to its component file").toBeTruthy();

  const calls = bundle.graphs.calls ?? [];
  expect(calls.some(
      (e) =>
        e.kind === "route-handler-link" &&
        e.from === moduleFile &&
        e.to === heroes,
    ), "route-handler-link edge points at the resolved component").toBeTruthy();
});

test("framework route detection is language-gated (no NestJS patterns in Python, vice versa)", () => {
  // A Python file with a class named like a NestJS controller must not trip the
  // TS-only decorators; a TS file must not trip the Python decorators.
  const py = "service/models.py";
  const ts = "src/util/helpers.ts";
  const routes = routesOf({
    [py]: "@Controller('nope')\nclass X:\n    @Get()\n    def f(self):\n        return 1\n",
    [ts]: 'const app = 1;\n// @app.get("/no") in a comment\n',
  });
  expect(!routes.some((r) => r.path === "/nope"), "NestJS decorators are not detected in .py files").toBeTruthy();
  expect(!routes.some((r) => r.path === "/no"), "FastAPI comments in .ts files are not detected as Python routes").toBeTruthy();
});

// COR-74363fa8 / inv-1: EVERY framework branch is gated on a positive marker in
// the file's content. The Python decorator pattern matches `@<object>.<verb>("s")`,
// which is also the shape of the ubiquitous test idiom `@mock.patch("...")`, so a
// bare `.py` extension fabricated routes out of patched tests.
test("inv-1: Python route detection requires a framework marker, not a .py extension", () => {
  const unmarked = extractFrameworkRouteEvidence(
    "tests/test_x.py",
    '@mock.patch("os.environ")\ndef test_x():\n    pass\n',
    new Map(),
  );
  expect(unmarked.routes, "@mock.patch is not a route decorator").toEqual([]);
  expect(unmarked.calls, "no handler edge either").toEqual([]);

  // A decorator that only LOOKS like a route, in a file with no framework import.
  const unmarkedRoute = extractFrameworkRouteEvidence(
    "scripts/tasks.py",
    '@celery.route("/not-a-web-route")\ndef task():\n    pass\n',
    new Map(),
  );
  expect(unmarkedRoute.routes, "an unmarked file is never pattern-matched").toEqual([]);

  // Positive control: the same decorator shape under a FastAPI marker IS a route.
  const marked = extractFrameworkRouteEvidence(
    "app/main.py",
    [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      '@app.get("/x")',
      "def read_x():",
      "    return 1",
    ].join("\n"),
    new Map(),
  );
  expect(marked.routes).toEqual([
    { path: "/x", handler: "app/main.py", method: "GET" },
  ]);

  // A Flask marker qualifies the same way.
  const flask = extractFrameworkRouteEvidence(
    "webapp/views.py",
    'import flask\n@app.route("/health")\ndef health():\n    return None\n',
    new Map(),
  );
  expect(flask.routes).toEqual([
    { path: "/health", handler: "webapp/views.py", method: "GET" },
  ]);
});

test("inv-1: an unmarked .py test file contributes no fabricated route to the graph", () => {
  const routes = routesOf({
    "tests/test_env.py": [
      "from unittest import mock",
      '@mock.patch("os.environ")',
      "def test_env(patched):",
      "    assert patched is not None",
    ].join("\n"),
  });
  expect(routes, "a patched test must produce no route edge").toEqual([]);
});

// The marker gate is FILE-scoped, so a framework's OWN test file passes it: it
// imports the framework AND is full of `@mock.patch("dotted.target")`, which the
// decorator pattern reads as a PATCH route once normalizeRoutePath manufactures
// a leading slash. The path literal is the per-decorator discriminator.
test("inv-1: a marker-carrying framework TEST file fabricates no route from @mock.patch", () => {
  const content = [
    "from fastapi.testclient import TestClient",
    "from unittest import mock",
    "from app.main import app",
    "",
    "client = TestClient(app)",
    "",
    '@mock.patch("app.service.get_user")',
    '@mock.patch("os.environ")',
    '@mock.patch("a.b.c")',
    "def test_get_user(abc, environ, get_user):",
    '    assert client.get("/users/1").status_code == 200',
  ].join("\n");

  const { routes, calls } = extractFrameworkRouteEvidence(
    "tests/test_users.py",
    content,
    new Map(),
  );
  expect(
    routes,
    "no /app.service.get_user, /os.environ or /a.b.c may be fabricated from a patched test",
  ).toEqual([]);
  expect(calls).toEqual([]);
});

test("inv-1: a relative decorator literal is not a route even under a framework marker", () => {
  // The method-decorator branch (@app.get / @router.post / @router.websocket).
  const methodDecorator = extractFrameworkRouteEvidence(
    "app/tasks.py",
    'from fastapi import FastAPI\napp = FastAPI()\n@app.get("items")\ndef items():\n    return []\n',
    new Map(),
  );
  expect(methodDecorator.routes, "a real FastAPI/Flask/Starlette route path is absolute").toEqual([]);

  // …and the route/api_route branch, which reads a DIFFERENT pattern and so
  // needs its own gate. `@celery.route("cleanup", methods=[...])` in a file that
  // happens to import flask is the shape that reaches it.
  const routeDecorator = extractFrameworkRouteEvidence(
    "app/jobs.py",
    [
      "from flask import Blueprint",
      'bp = Blueprint("bp", __name__)',
      '@scheduler.route("cleanup", methods=["GET"])',
      "def cleanup():",
      "    return None",
    ].join("\n"),
    new Map(),
  );
  expect(routeDecorator.routes, "the route/api_route branch is gated too").toEqual([]);

  // Positive control for that same branch.
  const absolute = extractFrameworkRouteEvidence(
    "app/views.py",
    [
      "from flask import Blueprint",
      'bp = Blueprint("bp", __name__)',
      '@bp.route("/cleanup", methods=["POST"])',
      "def cleanup():",
      "    return None",
    ].join("\n"),
    new Map(),
  );
  expect(absolute.routes).toEqual([
    { path: "/cleanup", handler: "app/views.py", method: "POST" },
  ]);
});

// F1-CLASS: the same fabrication class in extractRegisteredRouteEvidence, which
// was gated by neither language nor path shape.
test("inv-1 class: registered-route detection is gated by source extension AND an absolute path literal", () => {
  // Prose in a markdown file is not a route registration.
  const prose = extractRegisteredRouteEvidence(
    "docs/api.md",
    'Call `router.post("/users", createUser)` to register the handler.\n',
    new Map(),
  );
  expect(prose.routes, "documentation is not a route table").toEqual([]);
  expect(prose.calls).toEqual([]);

  // A relative literal in a real source file is not a route path either.
  const relative = extractRegisteredRouteEvidence(
    "src/queue.ts",
    'router.post("users", createUser);\n',
    new Map(),
  );
  expect(relative.routes).toEqual([]);

  // Positive control: a genuine registration in a source file still lands.
  const real = extractRegisteredRouteEvidence(
    "src/routes/users.ts",
    'router.post("/users", createUser);\n',
    new Map(),
  );
  expect(real.routes).toEqual([
    { path: "/users", handler: "src/routes/users.ts", method: "POST" },
  ]);
});

test("inv-1 class: a markdown file contributes no fabricated route to the graph", () => {
  const routes = routesOf({
    "docs/api.md": '# API\n\n`app.get("/health", healthHandler)` returns 200.\n',
  });
  expect(routes, "no route edge may come out of prose").toEqual([]);
});

// inv-6: the extractor array-order invariant — output is derived from CONTENT, so
// permuting the input array cannot move it.
test("inv-6: uniqueSortedRoutes output is independent of input order", () => {
  const input: RouteEdge[] = [
    { method: "GET", path: "/b", handler: "h2" },
    { method: "POST", path: "/a", handler: "h1" },
    { method: "GET", path: "/a", handler: "h1" },
    { method: "GET", path: "/a", handler: "h1" },
    { path: "/c", handler: "h3" },
  ];
  const expected = JSON.stringify(uniqueSortedRoutes(input));

  expect(JSON.stringify(uniqueSortedRoutes([...input].reverse())), "reversed input").toBe(expected);
  expect(JSON.stringify(uniqueSortedRoutes([input[4], input[1], input[3], input[0], input[2]])), "shuffled input").toBe(expected);
  expect(JSON.stringify(uniqueSortedRoutes([input[2], input[4], input[0], input[3], input[1]])), "another permutation").toBe(expected);
});

test("uniqueSortedRoutes dedupes by signature and sorts by path/handler/method", () => {
  const input: RouteEdge[] = [
    { method: "GET", path: "/b", handler: "h2" },
    { method: "GET", path: "/a", handler: "h2" },
    { method: "GET", path: "/a", handler: "h1" },
    // Exact duplicate of (GET, /a, h1) — must collapse to one.
    { method: "GET", path: "/a", handler: "h1" },
    // Differs only by method from (GET, /a, h1) — must be retained.
    { method: "POST", path: "/a", handler: "h1" },
  ];

  const result = uniqueSortedRoutes(input);
  // One exact dup removed -> 4 unique signatures.
  expect(result.length).toBe(4);
  expect(result.map((r) => `${r.method} ${r.path} ${r.handler}`)).toEqual(["GET /a h1", "POST /a h1", "GET /a h2", "GET /b h2"]);
});

test("fallbackRouteEdge returns a GET edge for api/route paths and undefined otherwise", () => {
  expect(fallbackRouteEdge("src/api/users.ts")).toEqual({
    method: "GET",
    handler: "src/api/users.ts",
    path: "/src_api_users.ts",
  });
  // A path whose final segment is exactly `route.ts` (Next.js App Router
  // convention) produces a defined fallback edge.
  const routeEdge = fallbackRouteEdge("app/dashboard/route.ts");
  expect(routeEdge).toBeTruthy();
  expect(routeEdge?.method).toBe("GET");
  expect(routeEdge?.handler).toBe("app/dashboard/route.ts");
  // An unrelated path yields no fallback edge.
  expect(fallbackRouteEdge("src/lib/util.ts")).toBe(undefined);
  // COR-c5438ac1: a bare "route" substring inside an identifier must NOT
  // fabricate a route edge — only `api/` segments or `route`/`routes` segments.
  expect(fallbackRouteEdge("src/router.ts")).toBe(undefined);
  expect(fallbackRouteEdge("src/extractors/graphRoutes.ts")).toBe(undefined);
  expect(fallbackRouteEdge("src/reroute-helper.ts")).toBe(undefined);
  // A `routes` directory segment still matches.
  expect(fallbackRouteEdge("app/routes/users.ts")).toBeTruthy();
});

// ---- extractConventionalRouteEvidence ----

test("extractConventionalRouteEvidence — App Router: file with exported GET/POST produces one route per method", () => {
  const file = "src/app/api/health/route.ts";
  const content = "export async function GET() {}\nexport async function POST() {}";
  const result = extractConventionalRouteEvidence(file, content);
  expect(result.length).toBe(2);
  expect(result.some((r) => r.method === "GET" && r.path === "/api/health" && r.handler === file), "GET /api/health").toBeTruthy();
  expect(result.some((r) => r.method === "POST" && r.path === "/api/health" && r.handler === file), "POST /api/health").toBeTruthy();
});

test("extractConventionalRouteEvidence — App Router: dynamic segment [id] maps to :id", () => {
  const file = "app/users/[id]/route.ts";
  const result = extractConventionalRouteEvidence(file, "export function GET() {}");
  expect(result.length).toBe(1);
  expect(result[0].method).toBe("GET");
  expect(result[0].path).toBe("/users/:id");
  expect(result[0].handler).toBe(file);
});

test("extractConventionalRouteEvidence — App Router: catch-all segment [...slug] maps to :slug*", () => {
  const file = "app/blog/[...slug]/route.ts";
  const result = extractConventionalRouteEvidence(file, "export function GET() {}");
  expect(result.length).toBe(1);
  expect(result[0].path).toBe("/blog/:slug*");
});

test("extractConventionalRouteEvidence — App Router: route group (marketing) segment is stripped", () => {
  const file = "app/(marketing)/about/route.ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  expect(result.length).toBe(1);
  expect(result[0].path).toBe("/about");
  expect(result[0].handler).toBe(file);
  expect(result[0].method, "no method on fallback route").toBe(undefined);
});

test("extractConventionalRouteEvidence — App Router: no exported HTTP methods produces a single method-less fallback route", () => {
  const file = "app/settings/route.ts";
  const result = extractConventionalRouteEvidence(file, "const config = {};");
  expect(result.length).toBe(1);
  expect(result[0].path).toBe("/settings");
  expect(result[0].handler).toBe(file);
  expect(result[0].method, "no method key on fallback route").toBe(undefined);
});

test("extractConventionalRouteEvidence — Pages/API: pages/api/users/[id].ts maps to /api/users/:id", () => {
  const file = "pages/api/users/[id].ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  expect(result.length).toBe(1);
  expect(result[0].path).toBe("/api/users/:id");
  expect(result[0].handler).toBe(file);
});

test("extractConventionalRouteEvidence — Pages/API: non-nested api path pages/api/health.ts maps to /api/health", () => {
  const file = "src/pages/api/health.ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  expect(result.length).toBe(1);
  expect(result[0].path).toBe("/api/health");
  expect(result[0].handler).toBe(file);
});

test("extractConventionalRouteEvidence — file matching neither convention returns empty array", () => {
  expect(extractConventionalRouteEvidence("src/lib/utils.ts", undefined)).toEqual([]);
  // HTTP method exports in a non-route file are ignored
  expect(extractConventionalRouteEvidence("src/components/Button.tsx", "export function GET() {}")).toEqual([]);
});

// FND-COR-c86f0260 regression: `api/` at the repo root without a `pages` ancestor
// must NOT be treated as a Next.js Pages Router API route.
test("FND-COR-c86f0260: api/ at repo root without pages/ ancestor is not a conventional API route", () => {
  // Paths that have `api` but no `pages` ancestor — must return empty.
  expect(extractConventionalRouteEvidence("api/components/page.ts", undefined)).toEqual([]);
  expect(extractConventionalRouteEvidence("api/health.ts", undefined)).toEqual([]);
  expect(extractConventionalRouteEvidence("src/api/users.ts", undefined)).toEqual([]);
});

// FND-COR-9fc7cbdb: extractImportBindings default-candidate split is already correct.
// `import DefaultExport, { named } from "..."` — split on comma/brace yields "DefaultExport".
// Verified via buildGraphBundle resolving the binding to the correct handler.
test("FND-COR-9fc7cbdb: import with default + named bindings resolves default to correct handler", () => {
  const file = "src/routes/auth.ts";
  const handler = "src/handlers/auth.ts";
  const bundle = bundleFor({
    [file]: [
      "import loginHandler, { validateToken } from '../handlers/auth';",
      "router.post('/login', loginHandler);",
    ].join("\n"),
    [handler]: "export default function loginHandler() {}\nexport function validateToken() {}\n",
  });
  const callEdge = (bundle.graphs.calls ?? []).find(
    (e) => e.from === file && e.to === handler && e.kind === "route-handler-link",
  );
  expect(callEdge !== undefined, "default import binding must resolve to the correct handler via route-handler-link").toBeTruthy();
});

// FND-COR-b29c9d4f: jsonc.ts stripJsonComments block-comment end index is correct.
// The character immediately after */ must NOT be skipped.
test("FND-COR-b29c9d4f: stripJsonComments preserves character immediately after block comment", async () => {
  const { stripJsonComments } = await import("../../src/audit/extractors/graphManifestEdges/jsonc.js");
  // "a/*b*/c" => "ac" (the 'c' after */ must be preserved)
  expect(stripJsonComments("a/*b*/c")).toBe("ac");
  // Newlines inside block comments are preserved.
  expect(stripJsonComments("a/*\n*/c")).toBe("a\nc");
  // Character directly after closing */ must not be swallowed.
  expect(stripJsonComments("x/* comment */y")).toBe("xy");
  // Verify a realistic JSONC snippet.
  const input = '{\n  // line comment\n  "key": /* block */ "value"\n}';
  const result = stripJsonComments(input);
  expect(result.includes('"key"'), "key must survive").toBeTruthy();
  expect(result.includes('"value"'), "value must survive").toBeTruthy();
  expect(!result.includes("//"), "line comment must be stripped").toBeTruthy();
  expect(!result.includes("block"), "block comment content must be stripped").toBeTruthy();
});
