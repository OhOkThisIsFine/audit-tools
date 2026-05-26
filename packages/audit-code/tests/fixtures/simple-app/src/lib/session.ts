import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Fixture-only session helper used by auditor-lambda tests.
 * Sessions are short-lived, server-issued, and revocable so the fixture
 * exercises more realistic audit paths than a plain `{ id }` stub.
 */

const FIXTURE_SESSION_SECRET = "simple-app-fixture-session-secret";
const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 12 * 60;

const revokedSessionIds = new Set<string>();

export interface Session {
  id: string;
  subject: string;
  issuedAt: string;
  expiresAt: string;
  signature: string;
  revoked: boolean;
}

type SessionCreationErrorCode =
  | "invalid_subject"
  | "invalid_ttl"
  | "invalid_session";

class SessionCreationError extends Error {
  constructor(
    readonly code: SessionCreationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionCreationError";
  }
}

export interface CreateSessionOptions {
  now?: Date;
  ttlMinutes?: number;
  logger?: Pick<Console, "warn">;
}

function assertValidSubject(subject: unknown): asserts subject is string {
  if (typeof subject !== "string") {
    throw new SessionCreationError(
      "invalid_subject",
      "Session subject must be a string.",
    );
  }

  const normalized = subject.trim();
  if (!/^[a-z0-9-]{3,64}$/.test(normalized)) {
    throw new SessionCreationError(
      "invalid_subject",
      "Session subject must be 3-64 lowercase alphanumeric characters.",
    );
  }
}

function resolveTtlMinutes(rawTtl: number | undefined): number {
  if (rawTtl === undefined) {
    return DEFAULT_TTL_MINUTES;
  }
  if (!Number.isInteger(rawTtl) || rawTtl <= 0 || rawTtl > MAX_TTL_MINUTES) {
    throw new SessionCreationError(
      "invalid_ttl",
      `ttlMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}.`,
    );
  }
  return rawTtl;
}

function signSession(
  id: string,
  subject: string,
  issuedAt: string,
  expiresAt: string,
): string {
  return createHmac("sha256", FIXTURE_SESSION_SECRET)
    .update(`${id}:${subject}:${issuedAt}:${expiresAt}`)
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

function assertValidSessionShape(session: Session): void {
  if (
    session.id.trim().length === 0 ||
    session.subject.trim().length === 0 ||
    Number.isNaN(Date.parse(session.issuedAt)) ||
    Number.isNaN(Date.parse(session.expiresAt)) ||
    !/^[a-f0-9]{64}$/.test(session.signature)
  ) {
    throw new SessionCreationError(
      "invalid_session",
      "Session shape is incomplete or malformed.",
    );
  }
}

export function createSession(
  subject: unknown,
  options: CreateSessionOptions = {},
): Session {
  const logger = options.logger ?? console;

  try {
    assertValidSubject(subject);
    const ttlMinutes = resolveTtlMinutes(options.ttlMinutes);
    const issuedAtDate = options.now ?? new Date();
    const issuedAt = issuedAtDate.toISOString();
    const expiresAt = new Date(
      issuedAtDate.getTime() + ttlMinutes * 60_000,
    ).toISOString();
    const normalizedSubject = subject.trim();
    const id = randomUUID();

    return {
      id,
      subject: normalizedSubject,
      issuedAt,
      expiresAt,
      signature: signSession(id, normalizedSubject, issuedAt, expiresAt),
      revoked: false,
    };
  } catch (error) {
    const reason =
      error instanceof SessionCreationError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    logger.warn(`[fixture-session] session creation rejected: ${reason}`);
    throw error;
  }
}

export function revokeSession(sessionId: string): void {
  revokedSessionIds.add(sessionId);
}

export function isSessionActive(
  session: Session,
  now: Date = new Date(),
): boolean {
  try {
    assertValidSessionShape(session);
    if (session.revoked || revokedSessionIds.has(session.id)) {
      return false;
    }
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      return false;
    }

    const expectedSignature = signSession(
      session.id,
      session.subject,
      session.issuedAt,
      session.expiresAt,
    );
    return signaturesMatch(expectedSignature, session.signature);
  } catch {
    return false;
  }
}
