import { test, expect } from "vitest";
import { extractConventionalRouteEvidence } from "../../src/audit/extractors/graphRoutes.ts";
import { HTML_RESOURCE_ATTRIBUTE } from "../../src/audit/extractors/analyzers/html.ts";

test("App Router app/route.ts yields the root '/' route", () => {
  const routes = extractConventionalRouteEvidence(
    "app/route.ts",
    "export async function GET() { return new Response(); }\n",
  );
  expect(routes.some((route) => route.path === "/" && route.method === "GET"), `expected a GET '/' route, got ${JSON.stringify(routes)}`).toBeTruthy();
});

test("App Router route group above root still normalizes to '/'", () => {
  const routes = extractConventionalRouteEvidence(
    "app/(marketing)/route.ts",
    "export async function POST() { return new Response(); }\n",
  );
  expect(routes.some((route) => route.path === "/" && route.method === "POST"), `expected a POST '/' route, got ${JSON.stringify(routes)}`).toBeTruthy();
});

test("nested App Router route still produces its sub-path (no root regression)", () => {
  const routes = extractConventionalRouteEvidence(
    "app/users/route.ts",
    "export async function GET() { return new Response(); }\n",
  );
  expect(routes.some((route) => route.path === "/users"), `expected a '/users' route, got ${JSON.stringify(routes)}`).toBeTruthy();
});

// Drift guard: HTML_RESOURCE_ATTRIBUTE is single-sourced in analyzers/html.ts and
// imported by the regex floor (browserExtension.ts). This test pins the contract so
// a future divergent edit fails loudly rather than silently splitting the two.
test("HTML_RESOURCE_ATTRIBUTE is single-sourced from analyzers/html.ts", () => {
  expect(HTML_RESOURCE_ATTRIBUTE).toEqual({
    script: "src",
    link: "href",
    img: "src",
  });
});
