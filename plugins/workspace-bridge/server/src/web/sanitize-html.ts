// Sanitizes the HTML of a held email for the owner's approval page, with the HTMLRewriter built into
// Workers (no dependency). An allow list: a tag not on it is dropped and its content kept, the
// dangerous ones are dropped with their content, and an attribute not on the list is removed.
// Nothing remote is ever kept: no `img src` that is not an inline image, no `srcset`, no CSS
// `url()` or `@import`, no `link`, `meta`, `base`, `iframe`, `embed` or `form`; links lose
// their `javascript:` and every other scheme but http, https, mailto and tel.
//
// It fails closed: markup the rewriter cannot fully parse (an unterminated tag or comment at the
// end) or output that a second pass would still change makes `sanitizeEmailHtml` throw, and the
// approval page then says the HTML could not be previewed.
//
// This is one layer. The result is shown only in a sandboxed iframe (no scripts, no same origin)
// under a Content-Security-Policy that forbids every load, so a miss here is still contained
// (`previewDocument` in `preview-views.ts`).

/** Tags kept, with their content. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "big",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "tt",
  "u",
  "ul",
  "wbr",
]);

/**
 * Tags removed together with everything inside them. `button`, `object`, `canvas`, `video`, `audio`
 * and `map` are not here: their content is ordinary markup a recipient can read (button labels,
 * fallback text), so the tag goes and the sanitized content stays.
 */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
  "applet",
  "base",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "option",
  "param",
  "plaintext",
  "script",
  "select",
  "source",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "xmp",
]);

/** Attributes kept on any allowed tag. */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  "align",
  "bgcolor",
  "border",
  "cellpadding",
  "cellspacing",
  "class",
  "color",
  "colspan",
  "dir",
  "face",
  "height",
  "lang",
  "rowspan",
  "size",
  "style",
  "title",
  "valign",
  "width",
]);

const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i;
/** The only `src` kept: an inline raster image. Anything else is a remote load. */
const INLINE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;
/** Whether a browser ignores this character inside a URL scheme (`java<TAB>script:`). */
const isUrlNoise = (c: number): boolean =>
  c <= 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  (c >= 0x200b && c <= 0x200f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0xfeff;

/** A link target when it is http, https, mailto or tel, else undefined. */
export function safeHref(value: string): string | undefined {
  const flat = [...value].filter((ch) => !isUrlNoise(ch.codePointAt(0) ?? 0)).join("");
  return SAFE_LINK.test(flat) ? value.trim() : undefined;
}

/**
 * CSS with every way to load something or run something taken out: `url()`, `@import`,
 * `image-set()`, `expression()`, `behavior`, `-moz-binding`, and backslash escapes (which can hide
 * any of those). Used for `<style>` text and for `style` attributes.
 */
export function sanitizeCss(css: string): string {
  return css
    .replace(/\\/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@import\b[^;{}]*;?/gi, "")
    .replace(/(?:-webkit-)?(?:image-set|image|src|cross-fade|element|paint)\s*\([^)]*\)?/gi, "none")
    .replace(/url\s*\([^)]*\)?/gi, "none")
    .replace(/expression\s*\([^)]*\)?/gi, "none")
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, "");
}

/**
 * A `style` attribute, sanitized. The rewriter hands over the raw attribute text but a browser
 * decodes character references before it parses CSS (`&#117;rl(`), so each one is replaced by a
 * space first; CSS has no use for them.
 */
const safeStyle = (value: string): string => sanitizeCss(value.replace(/&#?[a-z0-9]*;?/gi, " "));

const escText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** What an image becomes: its alt text in brackets, so nothing is fetched. */
const imagePlaceholder = (alt: string | null): string =>
  `<span class="blocked-image">[image${alt ? `: ${escText(alt.slice(0, 120))}` : ""}]</span>`;

/** One rewrite. Throws when the markup ends inside a tag, attribute or comment (see below). */
async function rewriteOnce(markup: string): Promise<string> {
  // The rewriter passes an unparsed tail (an unterminated tag, quoted attribute or comment at the
  // very end) through unchanged, and the caller then closes it into live markup. A random marker
  // is appended: if the rewriter never reports it as text, the tail was not parsed and the whole
  // input is refused. The marker is random per call, so the sender cannot plant it.
  const marker = `wbend${crypto.randomUUID().replaceAll("-", "")}`;
  let seen = "";
  // A <style> element cannot nest, so one buffer serves them all.
  let styleText = "";
  const rewriter = new HTMLRewriter()
    .onDocument({
      text(chunk) {
        seen += chunk.text;
      },
      comments(c) {
        c.remove();
      },
    })
    .on("*", {
      element(el) {
        const tag = el.tagName.toLowerCase();
        if (DROPPED_WITH_CONTENT.has(tag)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          // form, html, body and any unknown tag: the text inside stays, the tag goes.
          el.removeAndKeepContent();
          return;
        }
        const attrs = [...el.attributes].map(([n, v]) => [n ?? "", v ?? ""] as const);
        if (tag === "img") {
          const alt = attrs.find(([n]) => n.toLowerCase() === "alt")?.[1] ?? null;
          const src = (attrs.find(([n]) => n.toLowerCase() === "src")?.[1] ?? "").trim();
          if (!INLINE_IMAGE.test(src)) {
            el.replace(imagePlaceholder(alt), { html: true });
            return;
          }
        }
        // All off first, so a kept `title` cannot erase the one set from an `href`.
        for (const [rawName] of attrs) el.removeAttribute(rawName);
        for (const [rawName, value] of attrs) {
          const name = rawName.toLowerCase();
          if (name === "style") {
            const css = safeStyle(value);
            if (css.trim() !== "") el.setAttribute("style", css);
          } else if (tag === "a" && name === "href") {
            const href = safeHref(value);
            if (href !== undefined) {
              el.setAttribute("href", href);
              el.setAttribute("title", href);
            }
          } else if (tag === "img" && (name === "src" || name === "alt")) {
            if (name === "src") el.setAttribute("src", value.trim());
            else el.setAttribute("alt", value);
          } else if (ALLOWED_ATTRS.has(name) && !(tag === "a" && name === "title")) {
            el.setAttribute(name, value);
          }
        }
        if (tag === "a") {
          // Dead on purpose: the sandbox has no popups, so a click does nothing.
          el.setAttribute("rel", "noopener noreferrer");
          el.setAttribute("target", "_blank");
        }
      },
    })
    .on("style", {
      text(chunk) {
        // A pattern can span chunks, so the text is gathered and written once, at the end.
        styleText += chunk.text;
        chunk.remove();
        if (chunk.lastInTextNode) {
          // No `<` survives, so no `</style` can be formed from what is left.
          chunk.after(sanitizeCss(styleText).replaceAll("<", ""), { html: true });
          styleText = "";
        }
      },
    });
  const out = await rewriter.transform(new Response(`${markup}${marker}`)).text();
  if (!seen.endsWith(marker))
    throw new Error("html sanitizer: markup ends inside a tag or comment");
  // The rewriter keeps a doctype; a fragment has no use for it.
  return out.replaceAll(marker, "").replace(/<!doctype[^>]*>/gi, "");
}

/**
 * The sanitized fragment of `markup`, safe to place in a document body (still to be shown only in
 * the sandboxed frame). Throws, and the caller shows no HTML, when the rewriter cannot parse the
 * markup or when a second pass would still change the result (something got through the first).
 */
export async function sanitizeEmailHtml(markup: string): Promise<string> {
  const once = await rewriteOnce(markup);
  if ((await rewriteOnce(once)) !== once) throw new Error("html sanitizer: output is not stable");
  return once;
}
