// Linear HTML-to-text and body truncation (ARCHITECTURE s.2, plan s.3.4). No DOM parser, and no
// regex that can backtrack on adversarial input: tags are found by one forward scan that stops at
// the next `<` or `>`, so every character is looked at a bounded number of times.

/** Characters kept from an HTML body when it is converted to text (the input is cut here). */
export const MAX_HTML_INPUT_CHARS = 1_000_000;
/** URLs longer than this are shortened (query and fragment dropped, then cut). */
export const MAX_URL_CHARS = 80;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  zwnj: "",
  zwj: "",
  shy: "",
};

const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,9});/g;

/** Decodes the common named entities and every numeric one; unknown entities stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (
        !Number.isInteger(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return "";
      }
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? whole;
  });
}

/** Elements whose end (and start) break the line. */
const BLOCK = new Set([
  "p",
  "div",
  "br",
  "tr",
  "li",
  "ul",
  "ol",
  "table",
  "blockquote",
  "pre",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "header",
  "footer",
  "address",
  "dl",
  "dt",
  "dd",
  "center",
]);
/** Elements with no end tag: never counted when skipping a hidden element. */
const VOID = new Set([
  "br",
  "img",
  "hr",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "wbr",
  "source",
  "track",
  "embed",
  "param",
]);
/** Elements whose content is dropped to the matching end tag. */
const RAW_SKIP = new Set([
  "style",
  "script",
  "head",
  "title",
  "template",
  "noscript",
  "svg",
  "object",
  "iframe",
]);

/** `display:none`, `visibility:hidden`, a zero font size or opacity, and the clipped-box tricks. */
const HIDDEN_STYLE =
  /(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?![0-9.]*[1-9])|opacity\s*:\s*0(?![.0-9])|max-height\s*:\s*0(?![.0-9])|mso-hide\s*:\s*all)/i;

function asciiLower(s: string): string {
  // `toLowerCase` can change the length of non-ASCII text, which would shift every index, so
  // only pure ASCII takes the fast path.
  if (!/[\u0080-￿]/.test(s)) return s.toLowerCase();
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** The index of the end tag `</name` (not `</name2`) at or after `from`, or -1. */
function findClose(lower: string, name: string, from: number): number {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const d = lower.charCodeAt(at + needle.length);
    if (!((d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45 || d === 58)) return at;
    at = lower.indexOf(needle, at + needle.length);
  }
  return -1;
}

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** The text between the name and the `>`. */
  rest: string;
}

/**
 * Reads the tag that starts at `html[i]` (`<`). The tag ends at the first `>`; a `<` before it
 * means this `<` was plain text. Returns null when it is not a tag.
 */
function readTag(html: string, lower: string, i: number): { tag: Tag; end: number } | null {
  let j = i + 1;
  let closing = false;
  if (lower.charCodeAt(j) === 47 /* / */) {
    closing = true;
    j++;
  }
  const c = lower.charCodeAt(j);
  if (!(c >= 97 && c <= 122)) return null;
  const nameStart = j;
  while (j < lower.length) {
    const d = lower.charCodeAt(j);
    if ((d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 58 || d === 45) j++;
    else break;
  }
  const name = lower.slice(nameStart, j);
  const restStart = j;
  while (j < html.length) {
    const d = html.charCodeAt(j);
    if (d === 62 /* > */) {
      const rest = html.slice(restStart, j);
      return { tag: { name, closing, selfClosing: rest.endsWith("/"), rest }, end: j + 1 };
    }
    if (d === 60 /* < */) return null;
    j++;
  }
  return null;
}

/** The value of attribute `name` in the text of a tag, or "". Bounded by the tag's length. */
function attr(rest: string, name: string): string {
  const lower = asciiLower(rest);
  let from = 0;
  for (;;) {
    const at = lower.indexOf(name, from);
    if (at < 0) return "";
    from = at + name.length;
    const before = at === 0 ? " " : (lower[at - 1] as string);
    if (!/[\s"']/.test(before)) continue;
    let k = from;
    while (k < rest.length && /\s/.test(rest[k] as string)) k++;
    if (rest[k] !== "=") continue;
    k++;
    while (k < rest.length && /\s/.test(rest[k] as string)) k++;
    const q = rest[k];
    if (q === '"' || q === "'") {
      const end = rest.indexOf(q, k + 1);
      return decodeEntities(rest.slice(k + 1, end < 0 ? rest.length : end));
    }
    let end = k;
    while (end < rest.length && !/[\s>]/.test(rest[end] as string)) end++;
    return decodeEntities(rest.slice(k, end));
  }
}

function isHidden(rest: string): boolean {
  if (rest.length === 0) return false;
  const lower = asciiLower(rest);
  if (/\shidden(?=[\s=/]|$)/.test(lower) && !/\shidden\s*=\s*["']?(?:false)/.test(lower))
    return true;
  if (/aria-hidden\s*=\s*["']?true/.test(lower)) return true;
  const style = attr(rest, "style");
  return style !== "" && HIDDEN_STYLE.test(style);
}

/** A long (tracking) URL cut to its origin and path, with an ellipsis when still too long. */
export function shortenUrl(url: string): string {
  if (url.length <= MAX_URL_CHARS) return url;
  let cut = url;
  const q = cut.search(/[?#]/);
  if (q >= 0) cut = cut.slice(0, q);
  if (cut.length > MAX_URL_CHARS) cut = `${cut.slice(0, MAX_URL_CHARS)}…`;
  else cut = `${cut}…`;
  return cut;
}

// A URL is a run of non-space, non-bracket characters: one forward pass, no backtracking.
const LONG_URL = /https?:\/\/[^\s<>"'()[\]]{70,}/g;

/** Shortens every URL longer than `MAX_URL_CHARS` in a text. */
export function shortenUrls(text: string): string {
  return text.replace(LONG_URL, (u) => shortenUrl(u));
}

/** Zero-width and soft-hyphen characters: invisible, so dropped from the text. */
const INVISIBLE = /(?:\u034F|[\u00AD\u061C\u180E\u200B-\u200F\u2060-\u2064\uFEFF])+/g;

/** Collapses whitespace runs and blank lines, trims. Every pattern here consumes its whole run. */
export function tidyText(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/[ \t\f\r  -   　]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface HtmlTextOptions {
  /** Stop after about this many output characters (the rest is dropped). */
  maxChars?: number;
}

/**
 * Converts HTML to readable text in one forward pass: `<style>`, `<script>`, comments and hidden
 * elements are dropped, block tags become line breaks, entities are decoded, links keep their
 * (shortened) address, and whitespace is collapsed. The work is linear in the input length.
 */
export function htmlToText(input: string, opts: HtmlTextOptions = {}): string {
  let html = input;
  if (input.length > MAX_HTML_INPUT_CHARS) {
    html = input.slice(0, MAX_HTML_INPUT_CHARS);
    // The cut may land inside a tag: drop the dangling start of it.
    const open = html.lastIndexOf("<");
    if (open > html.lastIndexOf(">")) html = html.slice(0, open);
  }
  const cap = opts.maxChars ?? Number.POSITIVE_INFINITY;
  const lower = asciiLower(html);
  const out: string[] = [];
  let size = 0;
  const emit = (s: string): void => {
    out.push(s);
    size += s.length;
  };

  let hideName = "";
  let hideDepth = 0;
  let anchorHref = "";
  let anchorStart = -1;
  let i = 0;
  const n = html.length;

  const closeAnchor = (): void => {
    if (anchorStart < 0) return;
    const text = tidyText(out.slice(anchorStart).join(""));
    if (/^https?:\/\//i.test(anchorHref)) {
      const short = shortenUrl(anchorHref);
      // Skip the address when the link text already shows it.
      if (!text.includes(short) && !text.includes(anchorHref) && text !== "") emit(` (${short})`);
    }
    anchorStart = -1;
    anchorHref = "";
  };

  while (i < n && size < cap) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      if (hideDepth === 0) {
        // Invisible characters are dropped here so a flood of them cannot use up `maxChars`.
        const seg = decodeEntities(html.slice(i, textEnd))
          .replace(INVISIBLE, "")
          .replace(/[ \t\r\n\f]+/g, " ");
        if (seg !== "") emit(seg);
      }
      i = textEnd;
      if (lt < 0) break;
    }
    // html[i] is `<`.
    if (lower.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (html.charCodeAt(i + 1) === 33 /* ! */ || html.charCodeAt(i + 1) === 63 /* ? */) {
      const end = html.indexOf(">", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const read = readTag(html, lower, i);
    if (!read) {
      if (hideDepth === 0) emit("<");
      i++;
      continue;
    }
    const { tag, end } = read;
    i = end;
    if (hideDepth > 0) {
      if (tag.name === hideName && !VOID.has(tag.name)) {
        if (tag.closing) hideDepth--;
        else if (!tag.selfClosing) hideDepth++;
      }
      continue;
    }
    if (!tag.closing && RAW_SKIP.has(tag.name)) {
      if (tag.selfClosing) continue;
      const close = findClose(lower, tag.name, i);
      if (close < 0) {
        // Only style, script and title swallow the rest of a document; for the others a missing
        // end tag is just a stray start tag.
        if (tag.name === "style" || tag.name === "script" || tag.name === "title") break;
        continue;
      }
      const gt = html.indexOf(">", close);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (!tag.closing && !VOID.has(tag.name) && !tag.selfClosing && isHidden(tag.rest)) {
      hideName = tag.name;
      hideDepth = 1;
      continue;
    }
    if (tag.name === "a") {
      if (tag.closing) closeAnchor();
      else {
        closeAnchor();
        anchorHref = attr(tag.rest, "href").trim();
        anchorStart = out.length;
      }
      continue;
    }
    if (tag.name === "img" && !tag.closing) {
      const alt = attr(tag.rest, "alt").trim();
      if (alt !== "") emit(` [${alt}] `);
      continue;
    }
    if (tag.name === "td" || tag.name === "th") {
      if (tag.closing) emit(" ");
      continue;
    }
    if (tag.name === "li") {
      if (!tag.closing) emit("\n- ");
      continue;
    }
    if (BLOCK.has(tag.name)) {
      emit(tag.name === "p" || /^h[1-6]$/.test(tag.name) ? "\n\n" : "\n");
    }
  }
  closeAnchor();
  let text = tidyText(out.join(""));
  if (text.includes("http")) text = shortenUrls(text);
  return text;
}

/** The marker `truncateBody` appends. */
export const truncationMarker = (shown: number, limit = 32_768): string =>
  `\n[truncated after ${shown} characters; pass maxBodyChars (up to ${limit}) to read more]`;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/**
 * Cuts `text` to `max` characters (never inside a surrogate pair) and appends a marker when
 * anything was dropped. `clipped` says the caller already dropped input before this text.
 */
export function truncateBody(text: string, max: number, clipped = false): Truncated {
  if (text.length <= max && !clipped) return { text, truncated: false };
  let cut = Math.min(text.length, max);
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut--;
  return { text: text.slice(0, cut) + truncationMarker(cut), truncated: true };
}

/**
 * `html` with every `<img>` that carries its picture inside the message (a `data:` URI) or points
 * at a MIME part (`cid:`) taken out; the image's `alt` text stays in its place. Gmail turns such
 * an image into an inline attachment when it sends the message, and mail clients such as Yahoo
 * then show that part as a broken attachment. An `<img>` with a web address is left alone. One
 * forward scan, like `htmlToText`.
 */
export function dropEmbeddedImages(html: string): string {
  const lower = asciiLower(html);
  let out = "";
  let from = 0;
  let at = nextPicture(lower, 0);
  while (at >= 0) {
    const name = lower.startsWith("<img", at) ? "img" : "source";
    const after = lower.charCodeAt(at + 1 + name.length);
    if ((after >= 97 && after <= 122) || (after >= 48 && after <= 57) || after === 45) {
      at = nextPicture(lower, at + 4); // <image>, <imgx>: some other element
      continue;
    }
    const end = tagEnd(html, at);
    if (end < 0) {
      // No `>` closes this tag, so a browser would not draw it; cut it and the rest here, which
      // also keeps the scan linear (every later start would only scan to the end again).
      out += html.slice(from, at);
      return out;
    }
    const rest = html.slice(at + 1 + name.length, end - 1).replace(/^\/+/, " ");
    if (embeddedSource(rest)) {
      const alt = name === "img" ? attr(rest, "alt").trim() : "";
      out += html.slice(from, at);
      out += alt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      from = end;
      at = nextPicture(lower, from);
    } else {
      at = nextPicture(lower, at + 4);
    }
  }
  return from === 0 ? html : out + html.slice(from);
}

/** The next `<img` or `<source` at or after `from`. */
function nextPicture(lower: string, from: number): number {
  const img = lower.indexOf("<img", from);
  const source = lower.indexOf("<source", from);
  return img < 0 ? source : source < 0 ? img : Math.min(img, source);
}

/** The index after the `>` that closes the tag at `at`, skipping a `>` inside quotes; -1 if none. */
function tagEnd(html: string, at: number): number {
  let quote = "";
  for (let j = at + 1; j < html.length; j++) {
    const c = html[j] as string;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return j + 1;
  }
  return -1;
}

/** Whether the src or srcset of a tag (the text after its name) is a `data:` or `cid:` address. */
function embeddedSource(rest: string): boolean {
  for (const name of ["src", "srcset"]) {
    const value = attr(rest, name)
      .replace(/&colon;|&#0*58;|&#x0*3a;/gi, ":")
      .replace(/[\t\n\r]/g, "")
      .trim();
    if (/^(?:data|cid):/i.test(value)) return true;
  }
  return false;
}
