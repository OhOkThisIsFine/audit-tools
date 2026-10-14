import { expect, test } from "vitest";
import { parseGitleaksVersion, parseOsvScannerVersion, parseHadolintVersion, parseActionlintVersion } from "../../src/shared/analyzers/binaryVersions.js";

// Source-derived grammars, NOT runtime captures or packaged-binary smoke.
// https://raw.githubusercontent.com/gitleaks/gitleaks/v8.21.2/cmd/version.go
// https://raw.githubusercontent.com/google/osv-scanner/v2.4.0/cmd/osv-scanner/internal/cmd/run.go
// https://raw.githubusercontent.com/hadolint/hadolint/v2.14.0/src/Hadolint/Meta.hs
// https://raw.githubusercontent.com/rhysd/actionlint/v1.7.12/command.go
const cases = [
  [parseGitleaksVersion, "8.21.2", "8.21.2"],
  // scalibr metadata is synthetic; it is deliberately not the scanner pin.
  [parseOsvScannerVersion, "osv-scanner version: 2.4.0\nosv-scalibr version: 0.0.0\ncommit: n/a\nbuilt at: n/a", "2.4.0"],
  [parseHadolintVersion, "Haskell Dockerfile Linter 2.14.0", "2.14.0"],
  [parseActionlintVersion, "1.7.12\ninstalled by downloading from release page\nbuilt with go1.24.0 compiler for linux/amd64", "1.7.12"],
  [parseActionlintVersion, "v1.7.12\ninstalled from source\nbuilt with go1.24.0 compiler for windows/amd64", "1.7.12"],
] as const;
test.each(cases)("exact tagged stdout grammar %#", (parse, stdout, version) => {
  expect(parse(stdout)).toBe(version);
  expect(parse(stdout + "\n")).toBe(version);
  expect(parse((stdout + "\n").replaceAll("\n", "\r\n"))).toBe(version);
  for (const bad of ["prose\n" + stdout, stdout + "\nextra", stdout + "\n" + stdout, "\x1b[31m" + stdout]) expect(parse(bad)).toBeNull();
});
test("syntax and compatibility equality are distinct", () => {
  expect(parseGitleaksVersion("8.18.4\n")).toBe("8.18.4");
  for (const bad of ["v8.21.2", "gitleaks 8.21.2", "8.21.2-dev", "8.21.2+build", "8.21.2\n\n"]) expect(parseGitleaksVersion(bad)).toBeNull();
  expect(parseActionlintVersion("(devel)\nsource\nbuilt with go1.24 compiler for linux/amd64")).toBeNull();
  expect(parseOsvScannerVersion("osv-scanner version: 2.4.0\nosv-scalibr version: 2.4.0\ncommit: \nbuilt at: n/a")).toBeNull();
});
test("Actionlint rejects ANSI anywhere in compiler/platform/architecture records", () => {
  for (const tail of ["linux/amd64\x1b[0m", "\x1b[31mlinux/amd64", "linux/\x1b[31mamd64"]) {
    expect(parseActionlintVersion(`1.7.12\ninstalled from source\nbuilt with go1.24 compiler for ${tail}`)).toBeNull();
  }
});
