// WebCrypto helpers (ARCHITECTURE s.2). M4: random ids, SHA-256, HMAC, constant-time compare.

const encoder = new TextEncoder();

type Data = string | Uint8Array;

const bytesOf = (data: Data): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** `prefix` plus 16 base32 characters (80 random bits), for example an owner id `o_...`. */
export function randomId(prefix: string): string {
  return prefix + base32(randomBytes(10));
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export async function sha256(data: Data): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(data)));
}

export async function sha256Hex(data: Data): Promise<string> {
  return hex(await sha256(data));
}

export async function hmacSha256(key: Data, data: Data): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    bytesOf(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytesOf(data)));
}

/** Constant-time for equal lengths; different lengths return false at once. */
export function timingSafeEqual(a: Data, b: Data): boolean {
  const x = bytesOf(a);
  const y = bytesOf(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// M6 adds AES-256-GCM `seal` and `open` here, with AAD and key version (ARCHITECTURE s.4).
