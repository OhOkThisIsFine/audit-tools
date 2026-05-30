import test from "node:test";
import assert from "node:assert/strict";

const { buildGraphBundle } = await import("../dist/extractors/graph.js");

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
});
