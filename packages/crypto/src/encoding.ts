import { sodium } from "./sodium.js";

/** URL-safe base64 without padding. Safe for JSON bodies and URL fragments alike. */
export function toB64(data: Uint8Array): string {
  const s = sodium();
  return s.to_base64(data, s.base64_variants.URLSAFE_NO_PADDING);
}

export function fromB64(data: string): Uint8Array {
  const s = sodium();
  return s.from_base64(data, s.base64_variants.URLSAFE_NO_PADDING);
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function utf8Decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export function toHex(data: Uint8Array): string {
  return sodium().to_hex(data);
}

export function fromHex(hex: string): Uint8Array {
  return sodium().from_hex(hex);
}
