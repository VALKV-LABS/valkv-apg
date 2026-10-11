/**
 * Secrets handling (spec §17).
 *
 * - High-entropy tokens and API keys are stored as SHA-256.
 * - Private keys and `{ $secret }` values are encrypted with AES-256-GCM under
 *   `APG_SECRET_KEY`, a random nonce per value, and the resource kind and id
 *   as associated data, so a ciphertext cannot be moved to another resource.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

/** Parses a base64 secret key. Throws unless it decodes to exactly 32 bytes. */
export function parseSecretKey(base64: string, name = "APG_SECRET_KEY"): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded (got ${key.length} bytes)`);
  return key;
}

/** Encrypts and decrypts values bound to a resource. */
export class SecretBox {
  constructor(
    private readonly current: Buffer,
    private readonly previous?: Buffer,
  ) {}

  /** Encrypts `plaintext` for the resource identified by `aad`. */
  seal(plaintext: string, aad: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.current, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, nonce.toString("base64"), body.toString("base64"), cipher.getAuthTag().toString("base64")].join(":");
  }

  /** Decrypts a value sealed for `aad`. Tries the current key, then the previous one. Throws if neither works. */
  open(ciphertext: string, aad: string): string {
    const parts = ciphertext.split(":");
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("unrecognised ciphertext format");
    const [, nonce, body, tag] = parts as [string, string, string, string];
    for (const key of [this.current, this.previous]) {
      if (!key) continue;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
      } catch {
        // try the next key
      }
    }
    throw new Error("ciphertext could not be decrypted with the configured keys");
  }
}

/** Hex SHA-256. */
export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random token: `prefix` followed by 43 base62 characters (about 256 bits). */
export function generateToken(prefix: string): string {
  let out = "";
  // Rejection sampling keeps the distribution uniform.
  while (out.length < 43) {
    for (const byte of randomBytes(64)) {
      if (byte < 248 && out.length < 43) out += BASE62[byte % 62];
    }
  }
  return prefix + out;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A time-ordered UUID (version 7). */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
