import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Fixture-only authentication helper used by auditor-lambda tests.
 * It intentionally models structured validation, token expiry, and
 * signature verification without pretending to be production-ready auth.
 */

interface FixtureTokenRecord {
  readonly subject: string;
  readonly secret: string;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

type AuthenticationErrorCode =
  | "invalid_type"
  | "missing_token"
  | "invalid_format"
  | "unknown_token"
  | "expired_token"
  | "revoked_token"
  | "invalid_signature";

const FIXTURE_TOKEN_RECORDS: Readonly<Record<string, FixtureTokenRecord>> = {
  "fixture-admin": {
    subject: "admin-user",
    secret: "fixture-admin-signing-secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revoked: false,
  },
  "fixture-ops": {
    subject: "ops-user",
    secret: "fixture-ops-signing-secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revoked: false,
  },
  "fixture-revoked": {
    subject: "former-user",
    secret: "fixture-revoked-signing-secret",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revoked: true,
  },
};

class AuthenticationError extends Error {
  constructor(
    readonly code: AuthenticationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

interface ParsedToken {
  readonly tokenId: string;
  readonly nonce: string;
  readonly signature: string;
}

function parseToken(rawToken: unknown): ParsedToken {
  if (typeof rawToken !== "string") {
    throw new AuthenticationError(
      "invalid_type",
      "Expected token to be a string.",
    );
  }

  const token = rawToken.trim();
  if (token.length === 0) {
    throw new AuthenticationError(
      "missing_token",
      "Refusing to authenticate an empty token.",
    );
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AuthenticationError(
      "invalid_format",
      "Expected token format <token-id>.<nonce>.<signature>.",
    );
  }

  const [tokenId, nonce, signature] = parts;
  if (!/^[a-z0-9-]{8,}$/.test(tokenId)) {
    throw new AuthenticationError(
      "invalid_format",
      "Token id must be a lowercase fixture identifier.",
    );
  }
  if (!/^[a-z0-9-]{8,64}$/.test(nonce)) {
    throw new AuthenticationError(
      "invalid_format",
      "Nonce must be 8-64 lowercase alphanumeric characters.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new AuthenticationError(
      "invalid_format",
      "Signature must be a 64-character lowercase hex digest.",
    );
  }

  return { tokenId, nonce, signature };
}

function buildFixtureSignature(
  tokenId: string,
  nonce: string,
  secret: string,
): string {
  return createHash("sha256")
    .update(`${tokenId}:${nonce}:${secret}`)
    .digest("hex");
}

function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function getRecord(tokenId: string): FixtureTokenRecord {
  const record = FIXTURE_TOKEN_RECORDS[tokenId];
  if (!record) {
    throw new AuthenticationError(
      "unknown_token",
      `No fixture token named '${tokenId}' is registered.`,
    );
  }
  return record;
}

export function authenticate(
  token: unknown,
  options: { logger?: Pick<Console, "warn">; now?: Date } = {},
): boolean {
  const logger = options.logger ?? console;
  const now = options.now ?? new Date();

  try {
    const parsed = parseToken(token);
    const record = getRecord(parsed.tokenId);

    if (record.revoked) {
      throw new AuthenticationError(
        "revoked_token",
        `Fixture token '${parsed.tokenId}' has been revoked.`,
      );
    }
    if (Date.parse(record.expiresAt) <= now.getTime()) {
      throw new AuthenticationError(
        "expired_token",
        `Fixture token '${parsed.tokenId}' has expired.`,
      );
    }

    const expectedSignature = buildFixtureSignature(
      parsed.tokenId,
      parsed.nonce,
      record.secret,
    );
    if (!signaturesMatch(expectedSignature, parsed.signature)) {
      throw new AuthenticationError(
        "invalid_signature",
        `Fixture token '${parsed.tokenId}' failed signature validation.`,
      );
    }

    return true;
  } catch (error) {
    const reason =
      error instanceof AuthenticationError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    logger.warn(`[fixture-auth] authentication rejected: ${reason}`);
    return false;
  }
}
