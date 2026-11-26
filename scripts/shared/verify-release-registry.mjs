#!/usr/bin/env node
// sites-pinned: tests/audit/publish-source-contract.test.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {string} expectedSRI @param {string} tag @param {string} version @param {unknown} integrity @param {unknown} tags */
export function registryReleaseStatus(expectedSRI, tag, version, integrity, tags) {
  if (typeof integrity !== "string" || integrity.length === 0) return "pending";
  if (integrity !== expectedSRI) return "integrity-mismatch";
  const tagged = tags && typeof tags === "object" && Object.hasOwn(tags, tag)
    ? /** @type {Record<string, unknown>} */ (tags)[tag]
    : undefined;
  if (typeof tagged !== "string" || tagged.length === 0) return "pending";
  return tagged === version ? "confirmed" : "tag-mismatch";
}

/** @param {string} spec @param {string} field @returns {unknown} */
function view(spec, field) {
  const result = spawnSync("npm", ["view", spec, field, "--json", "--prefer-online", "--registry=https://registry.npmjs.org"], {
    encoding: "utf8", timeout: 4_000,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { RELEASE_TARBALL, PACKAGE_NAME, PACKAGE_VERSION, PUBLISH_TAG } = process.env;
  if (!RELEASE_TARBALL || !PACKAGE_NAME || !PACKAGE_VERSION || !PUBLISH_TAG) {
    throw new Error("Missing qualified tarball or release metadata.");
  }
  // The workflow already verified this exact download against the gate's SHA-256.
  const expectedSRI = "sha512-" + createHash("sha512").update(readFileSync(RELEASE_TARBALL)).digest("base64");
  const integrity = view(`${PACKAGE_NAME}@${PACKAGE_VERSION}`, "dist.integrity");
  const tags = integrity === expectedSRI ? view(PACKAGE_NAME, "dist-tags") : undefined;
  console.log(registryReleaseStatus(expectedSRI, PUBLISH_TAG, PACKAGE_VERSION, integrity, tags));
}
