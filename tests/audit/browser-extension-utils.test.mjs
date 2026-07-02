import { test, expect } from "vitest";

const {
  isBrowserExtensionManifestPath,
  hasBrowserExtensionManifestFile,
  deriveBrowserExtensionLensesForPath,
  inferBrowserExtensionUnitKind,
  buildBrowserExtensionSurfacesFromGraph,
} = await import("../../src/audit/extractors/browserExtension.ts");

// ── isBrowserExtensionManifestPath ───────────────────────────────────────────

test("isBrowserExtensionManifestPath returns true for manifest.json variants", () => {
  expect(isBrowserExtensionManifestPath("manifest.json")).toBe(true);
  expect(isBrowserExtensionManifestPath("C:\\ext\\manifest.json")).toBe(true);
  expect(isBrowserExtensionManifestPath("Manifest.JSON")).toBe(true);
  expect(isBrowserExtensionManifestPath("subdir/manifest.json")).toBe(true);
});

test("isBrowserExtensionManifestPath returns false for non-manifest paths", () => {
  expect(isBrowserExtensionManifestPath("src/manifest.json.ts")).toBe(false);
  expect(isBrowserExtensionManifestPath("manifest.json.bak")).toBe(false);
  expect(isBrowserExtensionManifestPath("notmanifest.json")).toBe(false);
  expect(isBrowserExtensionManifestPath("package.json")).toBe(false);
});

// ── hasBrowserExtensionManifestFile ─────────────────────────────────────────

test("hasBrowserExtensionManifestFile detects manifest.json in repo manifest file list", () => {
  expect(hasBrowserExtensionManifestFile({ files: [{ path: "manifest.json", size_bytes: 1 }] })).toBe(true);
  expect(hasBrowserExtensionManifestFile({ files: [{ path: "C:\\ext\\manifest.json", size_bytes: 1 }] })).toBe(true);
});

test("hasBrowserExtensionManifestFile returns false when no manifest.json is in the file list", () => {
  expect(hasBrowserExtensionManifestFile({ files: [{ path: "src/index.ts", size_bytes: 1 }] })).toBe(false);
  expect(hasBrowserExtensionManifestFile({ files: [] })).toBe(false);
});

// ── deriveBrowserExtensionLensesForPath ──────────────────────────────────────

test("deriveBrowserExtensionLensesForPath returns config lenses for manifest.json", () => {
  expect(deriveBrowserExtensionLensesForPath("manifest.json")).toEqual([
    "security",
    "correctness",
    "config_deployment",
    "operability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses for service/ prefix", () => {
  expect(deriveBrowserExtensionLensesForPath("service/main.js")).toEqual([
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses for background/ prefix", () => {
  expect(deriveBrowserExtensionLensesForPath("background/sw.js")).toEqual([
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses when path contains 'service-worker'", () => {
  expect(deriveBrowserExtensionLensesForPath("lib/service-worker.js")).toEqual([
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns content lenses for content/ prefix", () => {
  expect(deriveBrowserExtensionLensesForPath("content/script.js")).toEqual([
    "security",
    "correctness",
    "reliability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns content lenses when path contains 'content-script'", () => {
  expect(deriveBrowserExtensionLensesForPath("lib/content-script.js")).toEqual([
    "security",
    "correctness",
    "reliability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns UI lenses for HTML files", () => {
  expect(deriveBrowserExtensionLensesForPath("popup/popup.html")).toEqual([
    "security",
    "correctness",
    "maintainability",
  ]);
  expect(deriveBrowserExtensionLensesForPath("sidebar.html")).toEqual([
    "security",
    "correctness",
    "maintainability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns worker lenses for worker paths", () => {
  expect(deriveBrowserExtensionLensesForPath("download_worker.js")).toEqual([
    "correctness",
    "reliability",
    "performance",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns empty array for unmatched paths", () => {
  expect(deriveBrowserExtensionLensesForPath("utils/helpers.js")).toEqual([]);
});

// ── inferBrowserExtensionUnitKind ────────────────────────────────────────────

test("inferBrowserExtensionUnitKind returns 'extension_config' for manifest.json", () => {
  expect(inferBrowserExtensionUnitKind("manifest.json")).toBe("extension_config");
});

test("inferBrowserExtensionUnitKind returns 'extension_background' for service/ and background/ prefixes", () => {
  expect(inferBrowserExtensionUnitKind("service/main.js")).toBe("extension_background");
  expect(inferBrowserExtensionUnitKind("background/sw.js")).toBe("extension_background");
});

test("inferBrowserExtensionUnitKind returns 'extension_content' for content/ prefix", () => {
  expect(inferBrowserExtensionUnitKind("content/script.js")).toBe("extension_content");
});

test("inferBrowserExtensionUnitKind returns 'worker' for paths containing 'worker'", () => {
  expect(inferBrowserExtensionUnitKind("download_worker.js")).toBe("worker");
});

test("inferBrowserExtensionUnitKind returns 'extension_ui' for HTML files", () => {
  expect(inferBrowserExtensionUnitKind("popup.html")).toBe("extension_ui");
});

test("inferBrowserExtensionUnitKind returns undefined for unmatched paths", () => {
  expect(inferBrowserExtensionUnitKind("utils/helpers.js")).toBe(undefined);
});

// ── buildBrowserExtensionSurfacesFromGraph ───────────────────────────────────

test("buildBrowserExtensionSurfacesFromGraph returns [] for undefined graphBundle", () => {
  expect(buildBrowserExtensionSurfacesFromGraph(undefined)).toEqual([]);
});

test("buildBrowserExtensionSurfacesFromGraph returns [] when references is empty", () => {
  const bundle = { graphs: { references: [] } };
  expect(buildBrowserExtensionSurfacesFromGraph(bundle)).toEqual([]);
});

test("background-link edge to .js target yields surface with kind 'background' and exposure 'local'", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "background/sw.js", kind: "chrome-extension-background-link" },
      ],
    },
  };
  const surfaces = buildBrowserExtensionSurfacesFromGraph(bundle);
  expect(surfaces.length).toBe(1);
  expect(surfaces[0].kind).toBe("background");
  expect(surfaces[0].exposure).toBe("local");
  expect(surfaces[0].entrypoint).toBe("background/sw.js");
});

test("content-script-link edge to .js target yields surface with kind 'interface' and exposure 'network'", () => {
  const bundle = {
    graphs: {
      references: [
        {
          from: "manifest.json",
          to: "content/script.js",
          kind: "chrome-extension-content-script-link",
        },
      ],
    },
  };
  const surfaces = buildBrowserExtensionSurfacesFromGraph(bundle);
  expect(surfaces.length).toBe(1);
  expect(surfaces[0].kind).toBe("interface");
  expect(surfaces[0].exposure).toBe("network");
});

test("ui-page-link edge to .html target yields surface with kind 'interface' and exposure 'local'", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "popup/popup.html", kind: "chrome-extension-ui-page-link" },
      ],
    },
  };
  const surfaces = buildBrowserExtensionSurfacesFromGraph(bundle);
  expect(surfaces.length).toBe(1);
  expect(surfaces[0].kind).toBe("interface");
  expect(surfaces[0].exposure).toBe("local");
});

test("content-style-link edge produces no surface (not in EXTENSION_SURFACE_EDGE_KINDS)", () => {
  const bundle = {
    graphs: {
      references: [
        {
          from: "manifest.json",
          to: "content/style.css",
          kind: "chrome-extension-content-style-link",
        },
      ],
    },
  };
  expect(buildBrowserExtensionSurfacesFromGraph(bundle)).toEqual([]);
});

test("binary target (.png) is excluded by isExecutableExtensionSurfaceTarget", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "icons/icon.png", kind: "chrome-extension-background-link" },
      ],
    },
  };
  expect(buildBrowserExtensionSurfacesFromGraph(bundle)).toEqual([]);
});

test("duplicate kind+path combination is deduplicated to one surface", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "background/sw.js", kind: "chrome-extension-background-link" },
        { from: "manifest.json", to: "background/sw.js", kind: "chrome-extension-background-link" },
      ],
    },
  };
  const surfaces = buildBrowserExtensionSurfacesFromGraph(bundle);
  expect(surfaces.length).toBe(1);
});

test("file with excluded disposition status is skipped", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "vendor/bg.js", kind: "chrome-extension-background-link" },
      ],
    },
  };
  const disposition = { files: [{ path: "vendor/bg.js", status: "vendor" }] };
  expect(buildBrowserExtensionSurfacesFromGraph(bundle, disposition)).toEqual([]);
});

test("output surfaces are sorted by entrypoint then kind", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "z/content.js", kind: "chrome-extension-content-script-link" },
        { from: "manifest.json", to: "a/bg.js", kind: "chrome-extension-background-link" },
      ],
    },
  };
  const surfaces = buildBrowserExtensionSurfacesFromGraph(bundle);
  expect(surfaces.length).toBe(2);
  expect(surfaces[0].entrypoint).toBe("a/bg.js");
  expect(surfaces[1].entrypoint).toBe("z/content.js");
});
