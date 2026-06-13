import test from "node:test";
import assert from "node:assert/strict";
import { buildGraphBundle } from "../src/extractors/graph.ts";
import {
  extractConventionalRouteEvidence,
  fallbackRouteEdge,
  uniqueSortedRoutes,
} from "../src/extractors/graphRoutes.ts";

function manifest(paths) {
  return {
    files: paths.map((path) => ({
      path,
      size_bytes: 256,
      language: path.endsWith(".py") ? "python" : "typescript",
      excluded: false,
    })),
  };
}

function bundleFor(files) {
  return buildGraphBundle(manifest(Object.keys(files)), undefined, {
    fileContents: files,
  });
}

function routesOf(files) {
  return (bundleFor(files).graphs ?? {}).routes ?? [];
}

function hasRoute(routes, method, path, handler) {
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

  assert.ok(hasRoute(routes, "GET", "/cats", file), "GET /cats");
  assert.ok(hasRoute(routes, "GET", "/cats/:id", file), "GET /cats/:id");
  assert.ok(hasRoute(routes, "POST", "/cats", file), "POST /cats");
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
  assert.ok(hasRoute(routes, "POST", "/auth/login", file));
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

  assert.ok(hasRoute(routes, "GET", "/cats", file), "GET /cats from first controller");
  assert.ok(hasRoute(routes, "GET", "/dogs/:id", file), "GET /dogs/:id from second controller");
  assert.ok(hasRoute(routes, "POST", "/dogs", file), "POST /dogs from second controller");
  // The cats controller's GET must NOT pick up the dogs prefix
  assert.ok(!hasRoute(routes, "GET", "/dogs", file), "GET /dogs must not exist (cats has no prefix '/dogs')");
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

  assert.ok(hasRoute(routes, "GET", "/health", file), "GET /health — empty prefix leaves sub-path bare");
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

  assert.ok(hasRoute(routes, "GET", "/items/{item_id}", file));
  assert.ok(hasRoute(routes, "POST", "/items", file));
  assert.ok(hasRoute(routes, "WS", "/ws", file), "websocket maps to method WS");
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

  assert.ok(hasRoute(routes, "GET", "/login", file));
  assert.ok(hasRoute(routes, "POST", "/login", file));
  assert.ok(hasRoute(routes, "GET", "/health", file), "no methods defaults to GET");
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
  assert.ok(
    routes.some((r) => r.path === "/heroes" && r.handler === heroes),
    "heroes route resolves to its component file",
  );
  assert.ok(
    routes.some((r) => r.path === "/dashboard" && r.handler === dashboard),
    "dashboard route resolves to its component file",
  );

  const calls = bundle.graphs.calls ?? [];
  assert.ok(
    calls.some(
      (e) =>
        e.kind === "route-handler-link" &&
        e.from === moduleFile &&
        e.to === heroes,
    ),
    "route-handler-link edge points at the resolved component",
  );
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
  assert.ok(
    !routes.some((r) => r.path === "/nope"),
    "NestJS decorators are not detected in .py files",
  );
  assert.ok(
    !routes.some((r) => r.path === "/no"),
    "FastAPI comments in .ts files are not detected as Python routes",
  );
});

test("uniqueSortedRoutes dedupes by signature and sorts by path/handler/method", () => {
  const input = [
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
  assert.equal(result.length, 4);
  assert.deepEqual(
    result.map((r) => `${r.method} ${r.path} ${r.handler}`),
    ["GET /a h1", "POST /a h1", "GET /a h2", "GET /b h2"],
  );
});

test("fallbackRouteEdge returns a GET edge for api/route paths and undefined otherwise", () => {
  assert.deepEqual(fallbackRouteEdge("src/api/users.ts"), {
    method: "GET",
    handler: "src/api/users.ts",
    path: "/src_api_users.ts",
  });
  // A path containing 'route' also produces a defined fallback edge.
  const routeEdge = fallbackRouteEdge("app/dashboard/route.ts");
  assert.ok(routeEdge);
  assert.equal(routeEdge.method, "GET");
  assert.equal(routeEdge.handler, "app/dashboard/route.ts");
  // An unrelated path yields no fallback edge.
  assert.equal(fallbackRouteEdge("src/lib/util.ts"), undefined);
});

// ---- extractConventionalRouteEvidence ----

test("extractConventionalRouteEvidence — App Router: file with exported GET/POST produces one route per method", () => {
  const file = "src/app/api/health/route.ts";
  const content = "export async function GET() {}\nexport async function POST() {}";
  const result = extractConventionalRouteEvidence(file, content);
  assert.equal(result.length, 2);
  assert.ok(
    result.some((r) => r.method === "GET" && r.path === "/api/health" && r.handler === file),
    "GET /api/health",
  );
  assert.ok(
    result.some((r) => r.method === "POST" && r.path === "/api/health" && r.handler === file),
    "POST /api/health",
  );
});

test("extractConventionalRouteEvidence — App Router: dynamic segment [id] maps to :id", () => {
  const file = "app/users/[id]/route.ts";
  const result = extractConventionalRouteEvidence(file, "export function GET() {}");
  assert.equal(result.length, 1);
  assert.equal(result[0].method, "GET");
  assert.equal(result[0].path, "/users/:id");
  assert.equal(result[0].handler, file);
});

test("extractConventionalRouteEvidence — App Router: catch-all segment [...slug] maps to :slug*", () => {
  const file = "app/blog/[...slug]/route.ts";
  const result = extractConventionalRouteEvidence(file, "export function GET() {}");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/blog/:slug*");
});

test("extractConventionalRouteEvidence — App Router: route group (marketing) segment is stripped", () => {
  const file = "app/(marketing)/about/route.ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/about");
  assert.equal(result[0].handler, file);
  assert.equal(result[0].method, undefined, "no method on fallback route");
});

test("extractConventionalRouteEvidence — App Router: no exported HTTP methods produces a single method-less fallback route", () => {
  const file = "app/settings/route.ts";
  const result = extractConventionalRouteEvidence(file, "const config = {};");
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/settings");
  assert.equal(result[0].handler, file);
  assert.equal(result[0].method, undefined, "no method key on fallback route");
});

test("extractConventionalRouteEvidence — Pages/API: pages/api/users/[id].ts maps to /api/users/:id", () => {
  const file = "pages/api/users/[id].ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/api/users/:id");
  assert.equal(result[0].handler, file);
});

test("extractConventionalRouteEvidence — Pages/API: non-nested api path pages/api/health.ts maps to /api/health", () => {
  const file = "src/pages/api/health.ts";
  const result = extractConventionalRouteEvidence(file, undefined);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, "/api/health");
  assert.equal(result[0].handler, file);
});

test("extractConventionalRouteEvidence — file matching neither convention returns empty array", () => {
  assert.deepEqual(extractConventionalRouteEvidence("src/lib/utils.ts", undefined), []);
  // HTTP method exports in a non-route file are ignored
  assert.deepEqual(
    extractConventionalRouteEvidence("src/components/Button.tsx", "export function GET() {}"),
    [],
  );
});

// FND-COR-c86f0260 regression: `api/` at the repo root without a `pages` ancestor
// must NOT be treated as a Next.js Pages Router API route.
test("FND-COR-c86f0260: api/ at repo root without pages/ ancestor is not a conventional API route", () => {
  // Paths that have `api` but no `pages` ancestor — must return empty.
  assert.deepEqual(extractConventionalRouteEvidence("api/components/page.ts", undefined), []);
  assert.deepEqual(extractConventionalRouteEvidence("api/health.ts", undefined), []);
  assert.deepEqual(extractConventionalRouteEvidence("src/api/users.ts", undefined), []);
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
  assert.ok(
    callEdge !== undefined,
    "default import binding must resolve to the correct handler via route-handler-link",
  );
});

// FND-COR-b29c9d4f: jsonc.ts stripJsonComments block-comment end index is correct.
// The character immediately after */ must NOT be skipped.
test("FND-COR-b29c9d4f: stripJsonComments preserves character immediately after block comment", async () => {
  const { stripJsonComments } = await import(
    "../src/extractors/graphManifestEdges/jsonc.ts"
  );
  // "a/*b*/c" => "ac" (the 'c' after */ must be preserved)
  assert.equal(stripJsonComments("a/*b*/c"), "ac");
  // Newlines inside block comments are preserved.
  assert.equal(stripJsonComments("a/*\n*/c"), "a\nc");
  // Character directly after closing */ must not be swallowed.
  assert.equal(stripJsonComments("x/* comment */y"), "xy");
  // Verify a realistic JSONC snippet.
  const input = '{\n  // line comment\n  "key": /* block */ "value"\n}';
  const result = stripJsonComments(input);
  assert.ok(result.includes('"key"'), "key must survive");
  assert.ok(result.includes('"value"'), "value must survive");
  assert.ok(!result.includes("//"), "line comment must be stripped");
  assert.ok(!result.includes("block"), "block comment content must be stripped");
});
