import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP over RFC 4226 HOTP, HMAC-SHA1, 6 digits, 30-second steps:
 * the profile every authenticator app implements. Small enough to own
 * outright, and pinned by the RFC test vectors in the test suite.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;

/** RFC 4648 base32 (no padding), the alphabet authenticator apps expect. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(encoded: string): Uint8Array {
  const clean = encoded.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("invalid base32 character");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** A fresh 160-bit shared secret, base32 for the otpauth URI. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Uint8Array, counter: bigint): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", Buffer.from(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
    10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

export function totpAt(secretBase32: string, epochMs: number): string {
  const counter = BigInt(Math.floor(epochMs / 1000 / STEP_SECONDS));
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verifies a code with one step of clock drift in each direction. Returns the
 * matched step so callers can refuse to accept the same step twice (replay).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  epochMs: number,
): { valid: boolean; step: number } {
  const trimmed = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) {
    return { valid: false, step: 0 };
  }
  const secret = base32Decode(secretBase32);
  const currentStep = Math.floor(epochMs / 1000 / STEP_SECONDS);
  for (const drift of [0, -1, 1]) {
    const step = currentStep + drift;
    const expected = hotp(secret, BigInt(step));
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(trimmed))) {
      return { valid: true, step };
    }
  }
  return { valid: false, step: 0 };
}

/** otpauth:// URI for QR enrollment in any authenticator app. */
export function otpauthUri(secretBase32: string, email: string, issuer = "Engram Store"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
