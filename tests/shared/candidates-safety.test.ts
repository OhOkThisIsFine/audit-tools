import { describe, it, expect } from "vitest";
import {
  EXTERNAL_ANALYZER_CANDIDATES,
} from "../../src/shared/analyzers/candidates.js";

describe("AnalyzerSafetyProfile contract", () => {
  it("every candidate carries a safety profile", () => {
    for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
      expect(candidate.safetyProfile).toBeDefined();
      expect(candidate.safetyProfile.config_execution).toMatch(/^(none|inert-data|executable)$/);
      expect(typeof candidate.safetyProfile.network_egress).toBe("boolean");
      expect(candidate.safetyProfile.version_pinning).toMatch(/^(pinned|toolchain-resolved|unpinned)$/);
    }
  });

  it("defaultRun:true candidates meet the default eligibility rule", () => {
    const defaultEligible = (profile: typeof EXTERNAL_ANALYZER_CANDIDATES[0]["safetyProfile"]) =>
      profile.config_execution !== "executable" &&
      !profile.network_egress &&
      profile.version_pinning === "pinned";

    for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
      if (candidate.defaultRun) {
        const eligible = defaultEligible(candidate.safetyProfile);
        expect(eligible,
          `${candidate.id}: defaultRun:true requires ` +
          `config_execution !== "executable" && !network_egress && version_pinning === "pinned", ` +
          `got ${JSON.stringify(candidate.safetyProfile)}`
        ).toBe(true);
      }
    }
  });

  it("version pinning format matches runner (npx: @version, pipx: ==version, etc.)", () => {
    for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
      expect(candidate.spec).toBeTruthy();
      expect(candidate.spec.length).toBeGreaterThan(0);
      expect(candidate.spec).not.toMatch(/^\s*$/);

      // Verify format matches the runner type
      if (candidate.runner === "npx") {
        // npm packages: "packagename@version"
        expect(
          candidate.spec,
          `npx spec must contain @version: ${candidate.spec}`
        ).toMatch(/@[\d.]/);
      } else if (candidate.runner === "pipx") {
        // Python packages: "packagename==version"
        expect(
          candidate.spec,
          `pipx spec must contain ==version: ${candidate.spec}`
        ).toMatch(/==[\d.]/);
      } else if (candidate.runner === "cargo" || candidate.runner === "bundle") {
        // Toolchain-resolved specs are exempt from this format check
        // (cargo and bundle resolve via the tool's native version management)
      } else if (candidate.runner === "binary") {
        // Binary specs must have a concrete version (handled by binary acquisition)
        expect(candidate.spec.length).toBeGreaterThan(0);
      }
    }
  });

  // `version_pinning: "pinned"` is a claim the registry makes about REPRODUCIBILITY,
  // and the test above only proved a version-ish character followed the separator —
  // so a major RANGE ("type-coverage@2") satisfied it while resolving to a different
  // release, and a different transitive peer, on every fresh cache. That is not a
  // pin; it is a promise the registry cannot keep. Measured 2026-09-04: the range
  // `type-coverage@2` began resolving type-coverage 2.30.1 against typescript 7,
  // which no longer exposes `ts.SyntaxKind`, and the default-admitted analyzer
  // crashed at load on EVERY spawn — after paying a two-minute install first.
  //
  // The check is on the VERSION component, so each runner's spec shape is read
  // where it differs and the exactness rule is stated once.
  const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

  /**
   * The version component of a spec, by runner shape: npm `name@version` (the
   * name may itself be `@scope/pkg`, so the separator is the LAST `@` past
   * index 0), PyPI `name==version`, and a `binary` spec that IS the bare version.
   * `null` = no version component at all, which is never an exact pin.
   */
  function versionOf(runner: string, spec: string): string | null {
    if (runner === "npx") {
      const at = spec.lastIndexOf("@");
      return at > 0 ? spec.slice(at + 1) : null;
    }
    if (runner === "pipx") {
      const eq = spec.indexOf("==");
      return eq > 0 ? spec.slice(eq + 2) : null;
    }
    if (runner === "binary") return spec;
    return null;
  }

  it("a candidate claiming version_pinning:'pinned' names an EXACT version, never a range", () => {
    for (const candidate of EXTERNAL_ANALYZER_CANDIDATES) {
      if (candidate.safetyProfile.version_pinning !== "pinned") continue;
      const version = versionOf(candidate.runner, candidate.spec);
      expect(
        version,
        `${candidate.id}: spec '${candidate.spec}' carries no version component, ` +
        `so version_pinning:'pinned' is false`,
      ).not.toBeNull();
      expect(
        version,
        `${candidate.id}: spec '${candidate.spec}' pins a RANGE, not a version — ` +
        `version_pinning:'pinned' requires an exact x.y.z (a range re-resolves to a ` +
        `different release, and different transitive peers, on every fresh cache)`,
      ).toMatch(EXACT_SEMVER);

      // A peer exists precisely because the tool's own resolution of it is too
      // loose to be trusted, so a ranged peer reintroduces the whole defect.
      for (const peer of candidate.peers ?? []) {
        expect(
          versionOf(candidate.runner, peer),
          `${candidate.id}: peer '${peer}' must name an exact version — a peer is ` +
          `declared to REPLACE the tool's own loose resolution, so a range there ` +
          `restores exactly what it was added to prevent`,
        ).toMatch(EXACT_SEMVER);
      }
    }
  });
});
