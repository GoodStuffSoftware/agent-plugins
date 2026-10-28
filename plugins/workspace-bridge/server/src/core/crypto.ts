// WebCrypto helpers (ARCHITECTURE s.2). M4: random ids, SHA-256, HMAC, constant-time compare.
// M6: AES-256-GCM `seal` and `open` for tokens at rest.

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

// M6: AES-256-GCM sealing of Google tokens at rest (ARCHITECTURE s.4, `account_tokens`).
// Plaintext and key material are never logged and never appear in an error message.

export type TokenKind = "refresh" | "access";

const TOKEN_KINDS: ReadonlySet<string> = new Set<TokenKind>(["refresh", "access"]);

/** What a sealed token is bound to. The AAD is `ownerId|accountId|kind`. */
export interface SealAad {
  ownerId: string;
  accountId: string;
  kind: TokenKind;
}

/** The sealed columns of an `account_tokens` row. */
export interface Sealed {
  /** GCM ciphertext followed by the 16-byte tag. */
  ciphertext: Uint8Array;
  /** 12 random bytes, new for every seal. */
  iv: Uint8Array;
  /** 1 is `TOKEN_KEK`, N is `TOKEN_KEK_vN`. */
  key_version: number;
}

/** The env fields sealing reads; version N > 1 also reads `TOKEN_KEK_vN`. `Env` satisfies it. */
export interface KeyEnv {
  TOKEN_KEK?: string;
  CURRENT_KEY_VERSION?: string;
}

const IV_BYTES = 12;
const KEY_HINT = "32 random bytes, base64-encoded (openssl rand -base64 32)";
const decoder = new TextDecoder();

/** Imported keys, per isolate, keyed by the secret's text so a changed secret is re-imported. */
const importedKeys = new Map<string, Promise<CryptoKey>>();

/** The secret holding key version `version`. */
export function keyName(version: number): string {
  return version === 1 ? "TOKEN_KEK" : `TOKEN_KEK_v${version}`;
}

/** The version new seals use: `CURRENT_KEY_VERSION`, default 1. `config()` uses this parser too. */
export function currentKeyVersion(env: KeyEnv): number {
  const value = env.CURRENT_KEY_VERSION;
  if (value === undefined || value === "") return 1;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) {
    throw new Error("CURRENT_KEY_VERSION must be a positive integer");
  }
  return Number(value);
}

function tokenKey(env: KeyEnv, version: number): Promise<CryptoKey> {
  const name = keyName(version);
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is not set; it must be ${KEY_HINT}`);
  }
  const text = value.trim();
  let key = importedKeys.get(text);
  if (!key) {
    const raw = decodeKey(text);
    if (!raw) throw new Error(`${name} is malformed; it must be ${KEY_HINT}`);
    key = crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    importedKeys.set(text, key);
  }
  return key;
}

/** Standard base64 of exactly 32 bytes (padding optional), else null. */
function decodeKey(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(text)) return null;
  const binary = atob(text);
  if (binary.length !== 32) return null;
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function aadBytes({ ownerId, accountId, kind }: SealAad): Uint8Array {
  for (const part of [ownerId, accountId]) {
    if (typeof part !== "string" || part === "" || part.includes("|")) {
      throw new Error("token AAD ids must be non-empty and must not contain '|'");
    }
  }
  if (!TOKEN_KINDS.has(kind)) throw new Error("token kind must be refresh or access");
  return encoder.encode(`${ownerId}|${accountId}|${kind}`);
}

/** Encrypts `plaintext` under the current key version with a fresh IV, bound to `aad`. */
export async function seal(plaintext: string, aad: SealAad, env: KeyEnv): Promise<Sealed> {
  const additionalData = aadBytes(aad);
  const version = currentKeyVersion(env);
  const key = await tokenKey(env, version);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    encoder.encode(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, key_version: version };
}

/**
 * Decrypts a sealed row with the key of its own `key_version`. Throws if the key is missing,
 * or if the AAD, IV, ciphertext or tag do not match.
 */
export async function open(row: Sealed, aad: SealAad, env: KeyEnv): Promise<string> {
  const additionalData = aadBytes(aad);
  if (!(row.ciphertext instanceof Uint8Array) || !(row.iv instanceof Uint8Array)) {
    throw new Error("sealed token columns must be bytes; read the row with getToken");
  }
  if (!Number.isInteger(row.key_version) || row.key_version < 1) {
    throw new Error("sealed token has an invalid key version");
  }
  if (row.iv.byteLength !== IV_BYTES) throw new Error("sealed token has an invalid IV");
  const key = await tokenKey(env, row.key_version);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: row.iv, additionalData },
      key,
      row.ciphertext,
    );
  } catch {
    throw new Error("sealed token failed to decrypt: wrong key, wrong AAD or altered data");
  }
  return decoder.decode(plaintext);
}
