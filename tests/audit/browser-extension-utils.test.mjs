import test from "node:test";
import assert from "node:assert/strict";

const {
  isBrowserExtensionManifestPath,
  hasBrowserExtensionManifestFile,
  deriveBrowserExtensionLensesForPath,
  inferBrowserExtensionUnitKind,
  buildBrowserExtensionSurfacesFromGraph,
  chromeExtensionRiskSignalsForManifest,
} = await import("../../src/audit/extractors/browserExtension.ts");

// ── isBrowserExtensionManifestPath ───────────────────────────────────────────

test("isBrowserExtensionManifestPath returns true for manifest.json variants", () => {
  assert.equal(isBrowserExtensionManifestPath("manifest.json"), true);
  assert.equal(isBrowserExtensionManifestPath("C:\\ext\\manifest.json"), true);
  assert.equal(isBrowserExtensionManifestPath("Manifest.JSON"), true);
  assert.equal(isBrowserExtensionManifestPath("subdir/manifest.json"), true);
});

test("isBrowserExtensionManifestPath returns false for non-manifest paths", () => {
  assert.equal(isBrowserExtensionManifestPath("src/manifest.json.ts"), false);
  assert.equal(isBrowserExtensionManifestPath("manifest.json.bak"), false);
  assert.equal(isBrowserExtensionManifestPath("notmanifest.json"), false);
  assert.equal(isBrowserExtensionManifestPath("package.json"), false);
});

// ── hasBrowserExtensionManifestFile ─────────────────────────────────────────

test("hasBrowserExtensionManifestFile detects manifest.json in repo manifest file list", () => {
  assert.equal(
    hasBrowserExtensionManifestFile({ files: [{ path: "manifest.json", size_bytes: 1 }] }),
    true,
  );
  assert.equal(
    hasBrowserExtensionManifestFile({ files: [{ path: "C:\\ext\\manifest.json", size_bytes: 1 }] }),
    true,
  );
});

test("hasBrowserExtensionManifestFile returns false when no manifest.json is in the file list", () => {
  assert.equal(
    hasBrowserExtensionManifestFile({ files: [{ path: "src/index.ts", size_bytes: 1 }] }),
    false,
  );
  assert.equal(hasBrowserExtensionManifestFile({ files: [] }), false);
});

// ── deriveBrowserExtensionLensesForPath ──────────────────────────────────────

test("deriveBrowserExtensionLensesForPath returns config lenses for manifest.json", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("manifest.json"), [
    "security",
    "correctness",
    "config_deployment",
    "operability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses for service/ prefix", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("service/main.js"), [
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses for background/ prefix", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("background/sw.js"), [
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns background lenses when path contains 'service-worker'", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("lib/service-worker.js"), [
    "security",
    "correctness",
    "reliability",
    "observability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns content lenses for content/ prefix", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("content/script.js"), [
    "security",
    "correctness",
    "reliability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns content lenses when path contains 'content-script'", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("lib/content-script.js"), [
    "security",
    "correctness",
    "reliability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns UI lenses for HTML files", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("popup/popup.html"), [
    "security",
    "correctness",
    "maintainability",
  ]);
  assert.deepEqual(deriveBrowserExtensionLensesForPath("sidebar.html"), [
    "security",
    "correctness",
    "maintainability",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns worker lenses for worker paths", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("download_worker.js"), [
    "correctness",
    "reliability",
    "performance",
  ]);
});

test("deriveBrowserExtensionLensesForPath returns empty array for unmatched paths", () => {
  assert.deepEqual(deriveBrowserExtensionLensesForPath("utils/helpers.js"), []);
});

// ── inferBrowserExtensionUnitKind ────────────────────────────────────────────

test("inferBrowserExtensionUnitKind returns 'extension_config' for manifest.json", () => {
  assert.equal(inferBrowserExtensionUnitKind("manifest.json"), "extension_config");
});

test("inferBrowserExtensionUnitKind returns 'extension_background' for service/ and background/ prefixes", () => {
  assert.equal(inferBrowserExtensionUnitKind("service/main.js"), "extension_background");
  assert.equal(inferBrowserExtensionUnitKind("background/sw.js"), "extension_background");
});

test("inferBrowserExtensionUnitKind returns 'extension_content' for content/ prefix", () => {
  assert.equal(inferBrowserExtensionUnitKind("content/script.js"), "extension_content");
});

test("inferBrowserExtensionUnitKind returns 'worker' for paths containing 'worker'", () => {
  assert.equal(inferBrowserExtensionUnitKind("download_worker.js"), "worker");
});

test("inferBrowserExtensionUnitKind returns 'extension_ui' for HTML files", () => {
  assert.equal(inferBrowserExtensionUnitKind("popup.html"), "extension_ui");
});

test("inferBrowserExtensionUnitKind returns undefined for unmatched paths", () => {
  assert.equal(inferBrowserExtensionUnitKind("utils/helpers.js"), undefined);
});

// ── buildBrowserExtensionSurfacesFromGraph ───────────────────────────────────

test("buildBrowserExtensionSurfacesFromGraph returns [] for undefined graphBundle", () => {
  assert.deepEqual(buildBrowserExtensionSurfacesFromGraph(undefined), []);
});

test("buildBrowserExtensionSurfacesFromGraph returns [] when references is empty", () => {
  const bundle = { graphs: { references: [] } };
  assert.deepEqual(buildBrowserExtensionSurfacesFromGraph(bundle), []);
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
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].kind, "background");
  assert.equal(surfaces[0].exposure, "local");
  assert.equal(surfaces[0].entrypoint, "background/sw.js");
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
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].kind, "interface");
  assert.equal(surfaces[0].exposure, "network");
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
  assert.equal(surfaces.length, 1);
  assert.equal(surfaces[0].kind, "interface");
  assert.equal(surfaces[0].exposure, "local");
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
  assert.deepEqual(buildBrowserExtensionSurfacesFromGraph(bundle), []);
});

test("binary target (.png) is excluded by isExecutableExtensionSurfaceTarget", () => {
  const bundle = {
    graphs: {
      references: [
        { from: "manifest.json", to: "icons/icon.png", kind: "chrome-extension-background-link" },
      ],
    },
  };
  assert.deepEqual(buildBrowserExtensionSurfacesFromGraph(bundle), []);
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
  assert.equal(surfaces.length, 1);
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
  assert.deepEqual(buildBrowserExtensionSurfacesFromGraph(bundle, disposition), []);
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
  assert.equal(surfaces.length, 2);
  assert.equal(surfaces[0].entrypoint, "a/bg.js");
  assert.equal(surfaces[1].entrypoint, "z/content.js");
});

// ── chromeExtensionRiskSignalsForManifest ────────────────────────────────────

test("chromeExtensionRiskSignalsForManifest returns [] for invalid JSON", () => {
  assert.deepEqual(chromeExtensionRiskSignalsForManifest("not json :::"), []);
});

test("chromeExtensionRiskSignalsForManifest returns [] for non-object JSON", () => {
  assert.deepEqual(chromeExtensionRiskSignalsForManifest('"a string"'), []);
  assert.deepEqual(chromeExtensionRiskSignalsForManifest("[1,2,3]"), []);
});

test("chromeExtensionRiskSignalsForManifest returns [] for manifest with no manifest_version", () => {
  const content = JSON.stringify({ name: "ext", permissions: ["tabs"] });
  // No manifest_version means isBrowserExtensionManifest returns false.
  assert.deepEqual(chromeExtensionRiskSignalsForManifest(content), []);
});

test("chromeExtensionRiskSignalsForManifest returns [] when no high-risk permissions are present", () => {
  const content = JSON.stringify({
    manifest_version: 3,
    background: { service_worker: "sw.js" },
    permissions: ["storage", "alarms"],
  });
  assert.deepEqual(chromeExtensionRiskSignalsForManifest(content), []);
});

test("chromeExtensionRiskSignalsForManifest returns matched HIGH_RISK tokens from permissions array", () => {
  const content = JSON.stringify({
    manifest_version: 3,
    background: { service_worker: "sw.js" },
    permissions: ["tabs", "scripting", "storage"],
  });
  const result = chromeExtensionRiskSignalsForManifest(content);
  assert.ok(result.includes("tabs"), "expected 'tabs' in result");
  assert.ok(result.includes("scripting"), "expected 'scripting' in result");
  assert.ok(!result.includes("storage"), "expected 'storage' NOT in result");
});

test("chromeExtensionRiskSignalsForManifest matches tokens in optional_permissions", () => {
  const content = JSON.stringify({
    manifest_version: 3,
    background: { service_worker: "sw.js" },
    optional_permissions: ["<all_urls>"],
  });
  const result = chromeExtensionRiskSignalsForManifest(content);
  assert.ok(result.includes("<all_urls>"), "expected '<all_urls>' in result");
});

test("chromeExtensionRiskSignalsForManifest matches tokens in host_permissions", () => {
  const content = JSON.stringify({
    manifest_version: 3,
    background: { service_worker: "sw.js" },
    host_permissions: ["<all_urls>"],
  });
  const result = chromeExtensionRiskSignalsForManifest(content);
  assert.ok(result.includes("<all_urls>"), "expected '<all_urls>' in result");
});

test("chromeExtensionRiskSignalsForManifest deduplicates tokens present in multiple permission arrays", () => {
  const content = JSON.stringify({
    manifest_version: 3,
    background: { service_worker: "sw.js" },
    permissions: ["tabs"],
    optional_permissions: ["tabs"],
    host_permissions: ["tabs"],
  });
  const result = chromeExtensionRiskSignalsForManifest(content);
  assert.equal(
    result.filter((t) => t === "tabs").length,
    1,
    "expected 'tabs' to appear exactly once despite being in three arrays",
  );
});
