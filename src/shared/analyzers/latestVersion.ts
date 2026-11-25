// sites-pinned: tests/shared/analyzer-latest-version.test.ts, tests/audit/acquisition-executor.test.ts
import type { ExternalAnalyzerCandidate } from "./acquisitionEngine.js";
import type { BinaryFetcher, BinarySpec } from "./binaryAcquisition.js";
import { isRecord } from "../validation/basic.js";

const stableVersion = /^\d+\.\d+\.\d+$/;

function binaryRelease(spec: BinarySpec): string {
  const url = new URL(spec.releaseUrlForAsset("asset"));
  const match = /^\/([\w.-]+\/[\w.-]+)\/releases\/download\/v\d+\.\d+\.\d+\/asset$/.exec(url.pathname);
  if (url.origin !== "https://github.com" || !match) throw new Error("unsupported binary release source");
  return `https://api.github.com/repos/${match[1]}/releases/latest`;
}

function bindBinary(spec: BinarySpec, version: string): BinarySpec {
  const replace = (value: string) => value.replaceAll(spec.version, version);
  return {
    ...spec, version,
    assetFor(platform, arch) {
      const asset = spec.assetFor(platform, arch);
      return asset === null ? null : replace(asset);
    },
    checksumsAsset: typeof spec.checksumsAsset === "string" ? replace(spec.checksumsAsset) : spec.checksumsAsset,
    releaseUrlForAsset: asset => spec.releaseUrlForAsset(asset).replace(
      `/releases/download/v${spec.version}/`, `/releases/download/v${version}/`,
    ),
  };
}

/** Resolve a stable upstream release without fetching or executing any project code. */
export async function resolveAnalyzerRelease(
  candidate: ExternalAnalyzerCandidate,
  fetch: BinaryFetcher,
  timeoutMs: number,
  recordedVersion?: string,
): Promise<{ candidate: ExternalAnalyzerCandidate; version: string } | undefined> {
  const { runner, spec, binary } = candidate;
  const npmName = runner === "npx" ? /^(.*)@[^@]+$/.exec(spec)?.[1] : undefined;
  const pythonName = runner === "pipx" ? /^([\w.-]+)==.+$/.exec(spec)?.[1] : undefined;
  if (!npmName && !pythonName && !binary) return undefined;

  let version: unknown = recordedVersion;
  if (version === undefined) {
    if (!(timeoutMs > 0)) throw new Error("version lookup exceeded audit deadline");
    const url = npmName ? `https://registry.npmjs.org/${encodeURIComponent(npmName)}/latest`
      : pythonName ? `https://pypi.org/pypi/${encodeURIComponent(pythonName)}/json`
      : binaryRelease(binary!);
    const signal = AbortSignal.timeout(Math.min(timeoutMs, 15_000));
    const data = await fetch(url, signal);
    if (!data || signal.aborted) throw new Error("upstream release metadata unavailable");
    const metadata: unknown = JSON.parse(new TextDecoder().decode(data));
    if (!isRecord(metadata)) throw new Error("invalid upstream release metadata");
    version = npmName ? metadata.version
      : pythonName ? (isRecord(metadata.info) ? metadata.info.version : undefined)
      : (typeof metadata.tag_name === "string" ? metadata.tag_name.replace(/^v/, "") : undefined);
  }
  if (typeof version !== "string" || !stableVersion.test(version)) {
    throw new Error("upstream or recorded version is not an exact stable release");
  }
  return {
    version,
    candidate: {
      ...candidate,
      spec: npmName ? `${npmName}@${version}` : pythonName ? `${pythonName}==${version}` : version,
      ...(binary ? { binary: bindBinary(binary, version) } : {}),
      ...(candidate.npmLock ? { npmLock: undefined, npmEntrypoint: candidate.npmLock.entrypoint } : {}),
    },
  };
}
