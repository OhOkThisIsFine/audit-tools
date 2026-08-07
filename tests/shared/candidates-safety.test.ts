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
});
