// sites-pinned: tests/audit/publish-source-contract.test.ts, tests/audit/publish-registry-readback.test.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isScriptEntry } from "./primitives.mjs";
import { guardArgv } from "./argvGuard.mjs";

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

/** @typedef {"dist.integrity" | "dist-tags"} RegistryField */
/** @param {unknown} value @param {RegistryField} field */
function decodeRegistryValue(value, field) {
  if (value === null || value === undefined || value === "") return { status: "pending", detail: "metadata field absent" };
  if (field === "dist.integrity" && typeof value === "string") return { status: "ready", value };
  if (field === "dist-tags" && typeof value === "object" && !Array.isArray(value) &&
      Object.values(value).every(entry => typeof entry === "string" && entry.length > 0)) {
    return { status: "ready", value };
  }
  return { status: "unexpected-json", detail: "metadata field has the wrong JSON shape" };
}

const REGISTRY = "https://registry.npmjs.org";

/** @param {string} name @param {string} version @param {RegistryField} field */
async function directRegistryView(name, version, field) {
  const pkg = encodeURIComponent(name);
  const url = field === "dist.integrity"
    ? `${REGISTRY}/${pkg}/${encodeURIComponent(version)}`
    : `${REGISTRY}/-/package/${pkg}/dist-tags`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000), redirect: "error",
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response.status === 404
        ? { status: "pending", detail: "registry endpoint reported unavailable (HTTP 404)" }
        : { status: "query-error", detail: `registry endpoint HTTP ${response.status}` };
    }
    let metadata;
    try {
      metadata = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { status: "invalid-json", detail: "registry endpoint returned invalid JSON" };
    }
    if (field === "dist.integrity" &&
        (metadata?.name !== name || metadata?.version !== version)) {
      return { status: "unexpected-json", detail: "exact-version endpoint returned different identity" };
    }
    return decodeRegistryValue(field === "dist.integrity" ? metadata.dist?.integrity : metadata, field);
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return { status: "query-timeout", detail: "registry endpoint timed out" };
    }
    return { status: "query-error", detail: "registry endpoint request failed" };
  }
}

/** @param {string} expected @param {string} name @param {string} version @param {string} tag */
export async function verifyRegistryRelease(expected, name, version, tag) {
  // Query the exact version, not npm view's package-wide manifest, which can
  // successfully revalidate while still omitting a newly published version.
  const integrity = await directRegistryView(name, version, "dist.integrity");
  if (integrity.status !== "ready") {
    return { status: integrity.status, diagnostics: [`Registry dist.integrity: ${integrity.detail}.`] };
  }
  if (integrity.value !== expected) return { status: "integrity-mismatch", diagnostics: [] };

  const tags = await directRegistryView(name, version, "dist-tags");
  if (tags.status !== "ready") {
    return { status: tags.status, diagnostics: [`Registry dist-tags: ${tags.detail}.`] };
  }
  const status = registryReleaseStatus(expected, tag, version, integrity.value, tags.value);
  return { status, diagnostics: status === "pending" ? ["Registry dist-tags: requested tag is absent."] : [] };
}

async function main() {
  guardArgv(process.argv.slice(2), {
    name: "verify-release-registry",
    usage: "node scripts/shared/verify-release-registry.mjs",
  });
  const { RELEASE_TARBALL, PACKAGE_NAME, PACKAGE_VERSION, PUBLISH_TAG } = process.env;
  if (!RELEASE_TARBALL || !PACKAGE_NAME || !PACKAGE_VERSION || !PUBLISH_TAG) {
    throw new Error("Missing qualified tarball or release metadata.");
  }
  // The workflow already verified this exact download against the gate's SHA-256.
  const expectedSRI = "sha512-" + createHash("sha512").update(readFileSync(RELEASE_TARBALL)).digest("base64");
  const result = await verifyRegistryRelease(expectedSRI, PACKAGE_NAME, PACKAGE_VERSION, PUBLISH_TAG);
  for (const diagnostic of result.diagnostics) process.stderr.write(diagnostic + "\n");
  console.log(result.status);
}

if (isScriptEntry(import.meta.url, process.argv)) {
  main().catch(error => {
    process.exitCode = 1;
    console.error(error);
  });
}
