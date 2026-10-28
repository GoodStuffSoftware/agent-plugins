// Untrusted-content wrapper (ARCHITECTURE s.3.7). `UNTRUSTED_NOTE`, the sentence appended to the
// description of tools that return such text, lives in `registry/compile.ts`.

import { hex, randomBytes } from "./crypto";

export type UntrustedSource = "email" | "calendar" | "file" | "contact";

export interface UntrustedAttrs {
  source: UntrustedSource;
  /** The account key, for example `a1`. */
  account: string;
  /** For mail: the sender, as the message header gives it. */
  from?: string;
}

export interface Untrusted {
  /** 12 hex chars, new per tool call. */
  readonly nonce: string;
  wrap(text: string, attrs: UntrustedAttrs): string;
}

// U+200B-U+200F, U+202A-U+202E, U+2060-U+2069, U+FEFF (s.3.7), plus other invisible characters
// that hide text from a human reader: U+00AD, U+034F, U+061C, U+180E, and the Unicode Tags block
// U+E0000-U+E007F.
const isHiddenControl = (c: number): boolean =>
  (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2060 && c <= 0x2069) ||
  (c >= 0xe0000 && c <= 0xe007f) ||
  c === 0xfeff ||
  c === 0x00ad ||
  c === 0x034f ||
  c === 0x061c ||
  c === 0x180e;

/** Removes zero-width and bidirectional control characters. */
export function stripHiddenControls(text: string): string {
  let out = "";
  for (const ch of text) if (!isHiddenControl(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

/** Makes `<untrusted` and `</untrusted` (any case) inert, so content cannot open or close a block. */
export const neutralizeTags = (text: string): string =>
  text.replace(/<(\/?)untrusted/gi, "&lt;$1untrusted");

/** An attribute value for a double-quoted attribute: no quote, angle bracket or line break survives. */
export function escapeAttr(value: string): string {
  return stripHiddenControls(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n\t]+/g, " ");
}

/** One `Untrusted` per tool call; the nonce is unguessable to the author of the content. */
export function createUntrusted(): Untrusted {
  const nonce = hex(randomBytes(6));
  return {
    nonce,
    wrap(text, attrs) {
      const tag = `untrusted-${nonce}`;
      const from = attrs.from === undefined ? "" : ` from="${escapeAttr(attrs.from)}"`;
      const body = neutralizeTags(stripHiddenControls(text));
      return `<${tag} source="${escapeAttr(attrs.source)}" account="${escapeAttr(attrs.account)}"${from}>${body}</${tag}>`;
    },
  };
}
