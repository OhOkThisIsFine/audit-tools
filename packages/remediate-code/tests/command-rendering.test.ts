import { describe, it, expect } from "vitest";
import { loaderCommand } from "../src/steps/prompts.js";

describe("loaderCommand", () => {
  it("normalizes Windows absolute path args to forward slashes", () => {
    expect(
      loaderCommand(["next-step", "--root", "C:\\Code\\my-repo"]),
    ).toBe("remediate-code next-step --root C:/Code/my-repo");
  });

  it("normalizes Windows path args with spaces and quotes them", () => {
    expect(
      loaderCommand(["next-step", "--root", "C:\\My Repo\\project"]),
    ).toBe('remediate-code next-step --root "C:/My Repo/project"');
  });

  it("accepts a single string and splits it correctly", () => {
    expect(loaderCommand("next-step")).toBe("remediate-code next-step");
  });

  it("passes through POSIX paths unchanged", () => {
    expect(
      loaderCommand(["next-step", "--root", "/home/user/project"]),
    ).toBe("remediate-code next-step --root /home/user/project");
  });

  it("does not modify plain flag tokens", () => {
    expect(loaderCommand(["next-step", "--quiet"])).toBe(
      "remediate-code next-step --quiet",
    );
  });

  it("normalizes relative Windows paths that contain a file extension", () => {
    expect(
      loaderCommand(["next-step", "--artifacts-dir", ".\\audit-tools\\remediation"]),
    ).toBe("remediate-code next-step --artifacts-dir ./audit-tools/remediation");
  });
});
