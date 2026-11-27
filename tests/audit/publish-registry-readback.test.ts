import { afterEach, expect, test, vi } from "vitest";
import { verifyRegistryRelease } from "../../scripts/shared/verify-release-registry.mjs";

const sri = "sha512-qualified";
const name = "@scope/fixture";
const version = "1.2.3";
const exact = (integrity = sri, packageVersion = version) =>
  Response.json({ name, version: packageVersion, dist: { integrity } });
const verify = () => verifyRegistryRelease(sri, name, version, "latest");

afterEach(() => vi.unstubAllGlobals());

test("reads only official exact version and tag endpoints with revalidation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(exact()).mockResolvedValueOnce(Response.json({ latest: version }));
  vi.stubGlobal("fetch", fetcher);
  expect(await verify()).toEqual({ status: "confirmed", diagnostics: [] });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    "https://registry.npmjs.org/%40scope%2Ffixture/1.2.3",
    "https://registry.npmjs.org/-/package/%40scope%2Ffixture/dist-tags",
  ]);
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toEqual({ redirect: "error", signal: expect.any(AbortSignal),
      headers: { accept: "application/json", "cache-control": "no-cache" } });
  }
});

test.each([
  ["wrong bytes", () => exact("sha512-other"), "integrity-mismatch"],
  ["wrong exact identity", () => exact(sri, "9.0.0"), "unexpected-json"],
  ["missing exact version", () => new Response("do not log", { status: 404 }), "pending"],
  ["HTTP failure", () => new Response("do not log", { status: 503 }), "query-error"],
  ["invalid JSON", () => new Response("do not log"), "invalid-json"],
  ["missing integrity", () => Response.json({ name, version }), "pending"],
  ["malformed integrity", () => Response.json({ name, version, dist: { integrity: [sri] } }), "unexpected-json"],
])("%s stops before requesting tags", async (_label, response, status) => {
  const fetcher = vi.fn().mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", fetcher);
  const result = await verify();
  expect(result.status).toBe(status);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("do not log");
});

test.each([["TimeoutError", "query-timeout"], ["TypeError", "query-error"]])(
  "%s stays distinguishable from missing registry metadata", async (name, status) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("do not log"), { name })));
    const result = await verify();
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain("do not log");
  },
);

test.each([
  [{ latest: "1.2.2" }, "tag-mismatch"],
  [{ next: version }, "pending"],
  [{ latest: 42 }, "unexpected-json"],
])("exact bytes still require the requested tag to match (%j)", async (tags, status) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(exact()).mockResolvedValueOnce(Response.json(tags)));
  expect((await verify()).status).toBe(status);
});
