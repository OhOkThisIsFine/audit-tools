import { test, expect } from "vitest";

const { mergeCriticalFlowFallback, MAX_FALLBACK_FLOWS } = await import(
  "../../src/audit/extractors/flows.ts"
);

const deterministicManifest = () => ({
  flows: [
    {
      id: "flow:api:src/api/auth.ts",
      name: "api flow for src/api/auth.ts",
      entrypoints: ["src/api/auth.ts"],
      paths: ["src/api/auth.ts"],
      concerns: ["security"],
      confidence: "low",
    },
  ],
  fallback_required: true,
});

const flow = (over = {}) => ({
  id: "flow:host:checkout",
  name: "checkout",
  entrypoints: ["src/checkout.ts"],
  paths: ["src/checkout.ts", "src/billing.ts"],
  concerns: ["data_integrity"],
  confidence: "high",
  ...over,
});

test("adds a new host flow and re-derives fallback_required over the merged set", () => {
  const merged = mergeCriticalFlowFallback(deterministicManifest(), {
    flows: [flow()],
  });
  const ids = merged.flows.map((f) => f.id);
  expect(ids).toContain("flow:host:checkout");
  expect(ids).toContain("flow:api:src/api/auth.ts");
  // The deterministic flow is still low-confidence, so the bar remains unmet.
  expect(merged.fallback_required).toBe(true);
});

test("upgrades an existing flow when the host reuses its exact id", () => {
  const merged = mergeCriticalFlowFallback(deterministicManifest(), {
    flows: [
      {
        id: "flow:api:src/api/auth.ts",
        name: "authentication flow",
        entrypoints: ["src/api/auth.ts"],
        paths: ["src/api/auth.ts", "src/lib/session.ts"],
        concerns: ["security", "correctness"],
        confidence: "high",
      },
    ],
  });
  expect(merged.flows).toHaveLength(1);
  const upgraded = merged.flows[0];
  expect(upgraded.confidence).toBe("high");
  expect(upgraded.paths).toEqual(["src/api/auth.ts", "src/lib/session.ts"]);
  // The only flow is now high-confidence → the bar is met.
  expect(merged.fallback_required).toBe(false);
});

test("re-sorts the merged flows by id (stable, content-derived order)", () => {
  const merged = mergeCriticalFlowFallback(
    { flows: [flow({ id: "flow:z" })], fallback_required: false },
    { flows: [flow({ id: "flow:a" }), flow({ id: "flow:m" })] },
  );
  expect(merged.flows.map((f) => f.id)).toEqual(["flow:a", "flow:m", "flow:z"]);
});

test("skips invalid host flows without throwing", () => {
  const merged = mergeCriticalFlowFallback(
    { flows: [], fallback_required: true },
    { flows: [flow(), { id: "flow:bad" /* missing required fields */ }] },
  );
  expect(merged.flows.map((f) => f.id)).toEqual(["flow:host:checkout"]);
});

test("empty submission is a valid no-op merge (host found nothing to add)", () => {
  const base = deterministicManifest();
  const merged = mergeCriticalFlowFallback(base, { flows: [] });
  expect(merged.flows.map((f) => f.id)).toEqual(
    base.flows.map((f) => f.id),
  );
  expect(merged.fallback_required).toBe(true);
});

test("caps the number of accepted host flows at MAX_FALLBACK_FLOWS", () => {
  const many = Array.from({ length: MAX_FALLBACK_FLOWS + 5 }, (_unused, i) =>
    flow({ id: `flow:host:${String(i).padStart(4, "0")}` }),
  );
  const merged = mergeCriticalFlowFallback(
    { flows: [], fallback_required: true },
    { flows: many },
  );
  expect(merged.flows).toHaveLength(MAX_FALLBACK_FLOWS);
});
