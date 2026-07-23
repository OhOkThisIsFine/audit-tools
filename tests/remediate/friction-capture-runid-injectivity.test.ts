import { describe, it, expect } from "vitest";
import { sanitizeRunId, frictionCapturePath } from "audit-tools/shared";

const ART = "/artifacts";

describe("sanitizeRunId is injective (collision-free run-id encoding)", () => {
  // The failure mode CP-NODE-7 targets: a many-to-one collapse mapped distinct
  // run ids onto the same friction artifact path. These pairs must stay DISTINCT.
  const collidingPairs: Array<[string, string]> = [
    ["a/b", "a-b"],
    ["a/b", "a_b"],
    ["a b", "a-b"],
    ["a:b", "a-b"],
    ["a//b", "a-b"],
    ["-a-", "a"],
    ["foo/bar", "foo-bar"],
    ["x\\y", "x-y"],
  ];

  for (const [left, right] of collidingPairs) {
    it(`maps ${JSON.stringify(left)} and ${JSON.stringify(right)} to distinct tokens`, () => {
      expect(sanitizeRunId(left)).not.toBe(sanitizeRunId(right));
    });
    it(`maps ${JSON.stringify(left)} and ${JSON.stringify(right)} to distinct paths`, () => {
      expect(frictionCapturePath(ART, left)).not.toBe(frictionCapturePath(ART, right));
    });
  }

  it("produces filename-safe tokens (only [A-Za-z0-9._-])", () => {
    const ids = ["a/b", "a b", "héllo", "a:b\\c", "..", "", "_", "a_b"];
    for (const id of ids) {
      expect(sanitizeRunId(id)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it("is deterministic and stable for the same input", () => {
    expect(sanitizeRunId("a/b")).toBe(sanitizeRunId("a/b"));
  });

  it("yields a non-empty stem for the empty run id", () => {
    expect(sanitizeRunId("").length).toBeGreaterThan(0);
  });

  it("does not collide the empty id with any non-empty id", () => {
    const empty = sanitizeRunId("");
    for (const id of ["run", "_", "a", "0"]) {
      expect(sanitizeRunId(id)).not.toBe(empty);
    }
  });
});

describe("sanitizeRunId portable-filename hardening (INV-SCC-05 / COR-11e0ff4c)", () => {
  // Windows reserves device stems (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as
  // filenames — `CON.json` is unusable — and the reservation keys off the stem
  // BEFORE the first dot, case-insensitively. A purely alphanumeric run id like
  // "CON" previously survived encoding verbatim, so a valid run could reach
  // close-out and then fail to persist its friction artifact on Windows.
  const reserved = ["CON", "con", "Nul", "PRN", "AUX", "COM1", "LPT9"];

  for (const id of reserved) {
    it(`encodes reserved device stem ${JSON.stringify(id)} to a non-reserved token`, () => {
      const token = sanitizeRunId(id);
      expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
      // The token (which becomes `<token>.json`) must not itself be a reserved
      // stem: reservation applies to the part before the first dot.
      const stem = token.split(".")[0] ?? token;
      expect(stem.toUpperCase()).not.toMatch(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/);
    });
  }

  it("keeps reserved-name escaping injective (CON vs its escaped spelling stay distinct)", () => {
    const tokens = ["CON", "con", "CONX", "_43ON", "C", "CO", "COM1", "COM10"].map((id) =>
      sanitizeRunId(id),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("does not escape non-reserved lookalikes (CONX, COM10 stay verbatim)", () => {
    // COM10 is NOT reserved (only COM1-COM9 are); CONX is not a device stem.
    expect(sanitizeRunId("CONX")).toBe("CONX");
    expect(sanitizeRunId("COM10")).toBe("COM10");
  });

  it("bounds the encoded token length for overlong run ids (Windows 255-char component limit)", () => {
    const long = "x".repeat(4000);
    const token = sanitizeRunId(long);
    expect(token.length).toBeLessThanOrEqual(200);
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("keeps distinct overlong ids on distinct tokens (digest disambiguation)", () => {
    const a = sanitizeRunId("x".repeat(4000) + "a");
    const b = sanitizeRunId("x".repeat(4000) + "b");
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(b.length).toBeLessThanOrEqual(200);
  });

  it("an overlong id's token never collides with a short id spelling the same prefix", () => {
    const long = "y".repeat(4000);
    const token = sanitizeRunId(long);
    // A short id that happens to equal the truncated token must map elsewhere.
    expect(sanitizeRunId(token)).not.toBe(token);
  });
});
