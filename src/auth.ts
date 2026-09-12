/**
 * Auth layer: session cookies and X-API-Key authentication.
 *
 * Ported 1:1 from app.py lines 33-124:
 *   - SECRET_KEY / session serializer (itsdangerous.URLSafeTimedSerializer)
 *   - create_session / verify_session
 *   - verify_api_key (constant-time compare against TMPUP_API_KEYS)
 *   - PUBLIC_PATHS / AuthMiddleware (Fastify `onRequest` hook)
 *
 * Wire compatibility matters: sessions signed by the Python service must keep
 * working after the cutover. The token format produced here is byte-for-byte
 * the one produced by `itsdangerous.URLSafeTimedSerializer(secret)` with the
 * default salt (`b"itsdangerous"`), default `TimestampSigner`,
 * `_CompactJSON` payload serializer and `django-concat` key derivation:
 *
 *   token = base64url(compact_json) + "." + base64url(be_uint_seconds)
 *           + "." + base64url(HMAC-SHA1(derived_key, payload + "." + timestamp))
 *
 *   derived_key = SHA1(salt + b"signer" + secret_key)   # salt = b"itsdangerous"
 *
 * See the fixture-token test in test/auth.test.ts for live compatibility proof.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import type { FastifyReply, FastifyRequest } from "fastify";
// Type-only import: pulls in the `@fastify/cookie` `request.cookies` augmentation
// without emitting a runtime import.
import type {} from "@fastify/cookie";

import { API_KEY_CLIENT, config } from "./config.js";

/** Serializer salt used by `itsdangerous.URLSafeTimedSerializer` by default. */
const SERIALIZER_SALT = "itsdangerous";

// ---------------------------------------------------------------------------
// itsdangerous exceptions
// ---------------------------------------------------------------------------

/** Equivalent of `itsdangerous.BadSignature`. */
export class BadSignature extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadSignature";
  }
}

/** Equivalent of `itsdangerous.BadTimeSignature`. */
export class BadTimeSignature extends BadSignature {
  constructor(message: string) {
    super(message);
    this.name = "BadTimeSignature";
  }
}

/** Equivalent of `itsdangerous.SignatureExpired`. */
export class SignatureExpired extends BadTimeSignature {
  constructor(message: string) {
    super(message);
    this.name = "SignatureExpired";
  }
}

/** Equivalent of `itsdangerous.BadPayload` (payload is not valid JSON). */
export class BadPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadPayload";
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers (itsdangerous/encoding.py)
// ---------------------------------------------------------------------------

/** `base64_encode`: URL-safe base64 without padding. */
function base64Encode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

/** `base64_decode`: URL-safe base64, tolerant of missing padding. */
function base64Decode(value: string): Buffer {
  // Node's base64url decoder ignores non-alphabet characters, like
  // Python's `base64.urlsafe_b64decode` with `validate=False`.
  return Buffer.from(value, "base64url");
}

/** `int_to_bytes`: 8-byte big-endian unsigned integer, leading zeros stripped. */
function intToBytes(num: number): Buffer {
  const full = Buffer.alloc(8);
  full.writeBigUInt64BE(BigInt(Math.trunc(num)));
  let start = 0;
  while (start < full.length && full[start] === 0) start += 1;
  return full.subarray(start);
}

/** `bytes_to_int`: big-endian unsigned integer (raises if more than 8 bytes). */
function bytesToInt(data: Buffer): number {
  if (data.length > 8) {
    throw new Error("malformed timestamp");
  }
  let value = 0;
  for (const byte of data) {
    value = value * 256 + byte;
  }
  return value;
}

// ---------------------------------------------------------------------------
// TimedSerializer
// ---------------------------------------------------------------------------

export interface TimedSerializerOptions {
  /** Signer salt. Defaults to `"itsdangerous"` (itsdangerous' serializer salt). */
  salt?: string;
  /**
   * Clock used for signing and for max-age validation, in unix seconds.
   * TypeScript equivalent of overriding `TimestampSigner.get_timestamp`;
   * defaults to `Math.floor(Date.now() / 1000)`.
   */
  now?: () => number;
}

/**
 * Drop-in equivalent of `itsdangerous.URLSafeTimedSerializer` for the subset
 * app.py uses (`dumps` / `loads` on JSON-serializable values).
 *
 * `loads` throws {@link BadSignature} / {@link SignatureExpired} /
 * {@link BadPayload} instead of returning null, mirroring itsdangerous.
 */
export class TimedSerializer {
  readonly secretKey: string;
  readonly salt: string;
  readonly now: () => number;

  constructor(secretKey: string, options: TimedSerializerOptions = {}) {
    this.secretKey = secretKey;
    this.salt = options.salt ?? SERIALIZER_SALT;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** django-concat key derivation: `SHA1(salt + b"signer" + secret_key)`. */
  private deriveKey(): Buffer {
    return createHash("sha1")
      .update(this.salt, "utf8")
      .update("signer", "utf8")
      .update(this.secretKey, "utf8")
      .digest();
  }

  /** `Signer.get_signature`: base64url(HMAC-SHA1(derived_key, value)). */
  private getSignature(value: string): string {
    return createHmac("sha1", this.deriveKey()).update(value, "utf8").digest().toString("base64url");
  }

  /** `Signer.verify_signature`: constant-time signature check. */
  private verifySignature(value: string, signature: string): boolean {
    const expected = createHmac("sha1", this.deriveKey()).update(value, "utf8").digest();
    const provided = base64Decode(signature);
    if (provided.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(provided, expected);
  }

  /** `URLSafeSerializerMixin.dump_payload`: compact JSON, zlib when shorter. */
  private dumpPayload(payload: unknown): string {
    const serialized = JSON.stringify(payload);
    const json = Buffer.from(serialized === undefined ? "null" : serialized, "utf8");
    const compressed = deflateSync(json);
    let encoded: string;
    if (compressed.length < json.length - 1) {
      encoded = `.${compressed.toString("base64url")}`;
    } else {
      encoded = json.toString("base64url");
    }
    return encoded;
  }

  /** `URLSafeSerializerMixin.load_payload`: base64url, optional zlib, JSON. */
  private loadPayload(payload: string): unknown {
    let data = payload;
    let decompress = false;
    if (data.startsWith(".")) {
      data = data.slice(1);
      decompress = true;
    }
    let json = base64Decode(data);
    if (decompress) {
      try {
        json = inflateSync(json);
      } catch (err) {
        throw new BadPayload(
          `Could not zlib decompress the payload before decoding the payload: ${String(err)}`,
        );
      }
    }
    try {
      return JSON.parse(json.toString("utf8"));
    } catch {
      throw new BadPayload(
        "Could not load the payload because an exception occurred on unserializing the data.",
      );
    }
  }

  /** `TimestampSigner.sign` + `Serializer.dumps`. */
  dumps(payload: unknown): string {
    const value = `${this.dumpPayload(payload)}.${base64Encode(intToBytes(this.now()))}`;
    return `${value}.${this.getSignature(value)}`;
  }

  /**
   * `TimestampSigner.unsign` + `Serializer.loads`.
   *
   * @throws {BadSignature} malformed token or bad signature
   * @throws {SignatureExpired} signed more than `maxAge` seconds ago (or in the future)
   * @throws {BadPayload} valid signature but the payload is not decodable JSON
   */
  loads(token: string | undefined, maxAge?: number): unknown {
    const signed = token ?? "";
    const sep = signed.lastIndexOf(".");
    if (sep === -1) {
      throw new BadSignature("No b'.' found in value");
    }
    const value = signed.slice(0, sep);
    const signature = signed.slice(sep + 1);
    if (!this.verifySignature(value, signature)) {
      throw new BadSignature(`Signature '${signature}' does not match`);
    }

    // TimestampSigner.unsign: split the unsigned value into payload + timestamp.
    const tsSep = value.lastIndexOf(".");
    if (tsSep === -1) {
      throw new BadTimeSignature("timestamp missing");
    }
    const payload = value.slice(0, tsSep);
    const tsEncoded = value.slice(tsSep + 1);

    let timestamp: number | null = null;
    try {
      timestamp = bytesToInt(base64Decode(tsEncoded));
    } catch {
      timestamp = null;
    }
    if (timestamp === null) {
      throw new BadTimeSignature("Malformed timestamp");
    }

    if (maxAge !== undefined && maxAge !== null) {
      const age = this.now() - timestamp;
      if (age > maxAge) {
        throw new SignatureExpired(`Signature age ${age} > ${maxAge} seconds`);
      }
      if (age < 0) {
        throw new SignatureExpired(`Signature age ${age} < 0 seconds`);
      }
    }

    return this.loadPayload(payload);
  }
}

// ---------------------------------------------------------------------------
// Session helpers (app.py 56-69)
// ---------------------------------------------------------------------------

/** `create_session`: sign `email` with the configured secret key. */
export function createSession(email: string, secretKey: string = config.secretKey): string {
  return new TimedSerializer(secretKey).dumps(email);
}

export interface VerifySessionOptions {
  /** Max accepted signature age in seconds. Defaults to `config.sessionMaxAge`. */
  maxAge?: number;
  /** Secret key override (defaults to `config.secretKey`). */
  secretKey?: string;
}

/**
 * `verify_session`: returns the email carried by the token, or `null` when the
 * token is missing, malformed, tampered with, or older than `maxAge`.
 *
 * Accepts either the Python positional form (`verifySession(token, maxAge)`)
 * or an options object (`verifySession(token, { maxAge, secretKey })`); the
 * secret override exists so tests can use a fixed key without touching config.
 */
export function verifySession(
  token: string | undefined,
  options: number | VerifySessionOptions = {},
): string | null {
  const opts: VerifySessionOptions = typeof options === "number" ? { maxAge: options } : options;
  const maxAge = opts.maxAge ?? config.sessionMaxAge;
  const secretKey = opts.secretKey ?? config.secretKey;
  const serializer = new TimedSerializer(secretKey);
  try {
    const value = serializer.loads(token, maxAge);
    // app.py dumps a plain string; anything else is not a valid session.
    return typeof value === "string" ? value : null;
  } catch (err) {
    // app.py catches (SignatureExpired, BadSignature). BadPayload (valid
    // signature but undecodable payload) is only reachable by someone holding
    // the secret key; the port also maps it to null.
    if (err instanceof BadSignature || err instanceof BadPayload) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// API-key auth (app.py 72-87)
// ---------------------------------------------------------------------------

/** Case-insensitive single-value header read (Starlette `headers.get`). */
function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) {
      continue;
    }
    if (value === undefined) {
      return "";
    }
    return Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return "";
}

/**
 * `verify_api_key`: validates the `X-API-Key` header with a constant-time
 * compare. Returns `API_KEY_CLIENT` on a match, `null` otherwise (or when no
 * API keys are configured).
 */
export function verifyApiKey(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  if (config.apiKeys.size === 0) {
    return null;
  }
  const provided = readHeader(headers, "X-API-Key");
  if (!provided) {
    return null;
  }
  const providedBuf = Buffer.from(provided, "utf8");
  for (const validKey of config.apiKeys) {
    const validBuf = Buffer.from(validKey, "utf8");
    if (providedBuf.length === validBuf.length && timingSafeEqual(providedBuf, validBuf)) {
      return API_KEY_CLIENT;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth middleware (app.py 58 + 90-112)
// ---------------------------------------------------------------------------

export const PUBLIC_PATHS: string[] = [
  "/health",
  "/auth/login",
  "/auth/google",
  "/auth/callback",
  "/auth/logout",
];

/** Public file-transfer prefixes. */
export const PUBLIC_PATH_PREFIXES: string[] = ["/d/", "/v/", "/t/"];

/** `AuthMiddleware` public-route check. */
export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) {
    return true;
  }
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * `AuthMiddleware.dispatch` as a Fastify `onRequest` hook: public paths pass,
 * a valid session cookie or API key passes, otherwise browsers
 * (`Accept: text/html`) are redirected to `/auth/login` and API clients get
 * the 401 JSON body.
 */
export async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const pathname = request.url.split("?")[0] ?? "";
  if (isPublicPath(pathname)) {
    return;
  }

  // 1) Session cookie (browser flow)
  const email = verifySession(request.cookies?.session);
  if (email) {
    return;
  }

  // 2) X-API-Key (headless flow)
  if (verifyApiKey(request.headers)) {
    return;
  }

  // 3) Browser -> login redirect; API client -> 401 JSON
  const accept = request.headers.accept ?? "";
  if (accept.includes("text/html")) {
    return reply.redirect("/auth/login", 302);
  }
  return reply
    .code(401)
    .send({ error: "unauthorized", detail: "Provide session cookie or X-API-Key header" });
}
